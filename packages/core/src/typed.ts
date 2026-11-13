// Typed widgets: `heading`, `metric`, `chart` and `table`. Their content is
// JSON data, not code. The app renders it.
//
// The rules are here, in core, so the browser and the agent peer obey the same
// rules. `cleanContent` checks a value and returns the JSON text to store.
// `readTyped` reads stored text and never throws: content from old peers or
// other versions can be anything.

export const TYPED_WIDGETS = ["heading", "metric", "chart", "table"] as const;
export type TypedWidgetType = (typeof TYPED_WIDGETS)[number];

export type Cell = string | number | boolean | null;

export interface HeadingContent {
  text: string;
  /** 1 (largest) to 3. Default 2. */
  level: 1 | 2 | 3;
}

export interface MetricContent {
  value: number | string;
  label: string;
  unit?: string;
  /** The change, e.g. 3.2 or "+4% vs last week". */
  delta?: number | string;
  /** Which direction of `delta` is good. Default "up". */
  better?: "up" | "down";
  /** Recent values, oldest first, for a sparkline. */
  trend?: number[];
}

/** A Vega-Lite spec with inline data only. */
export type ChartContent = Record<string, unknown>;

export interface TableContent {
  columns: string[];
  /** One array per row, in column order. */
  rows: Cell[][];
}

export interface TypedContent {
  heading: HeadingContent;
  metric: MetricContent;
  chart: ChartContent;
  table: TableContent;
}

export const TYPED_LIMITS = {
  headingText: 200,
  metricText: 100,
  trend: 200,
  /** Characters of the chart spec as compact JSON. */
  chartSpec: 100_000,
  /** Nesting depth of the chart spec. */
  chartDepth: 40,
  tableColumns: 50,
  tableRows: 1000,
  cellText: 1000,
};

export function isTypedWidget(type: unknown): type is TypedWidgetType {
  return (TYPED_WIDGETS as readonly unknown[]).includes(type);
}

/**
 * Check typed content and return the JSON text to store. `value` is the data,
 * or JSON text. Throws an error that says what is wrong.
 */
export function cleanContent(type: TypedWidgetType, value: unknown): string {
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      throw new Error(`The content of a ${type} widget must be JSON. ${SHAPES[type]}`);
    }
  }
  if (!isPlainObject(data)) throw new Error(`The content of a ${type} widget must be a JSON object. ${SHAPES[type]}`);
  return JSON.stringify(CLEAN[type](data));
}

/** Read stored typed content. Returns an error message instead of throwing. */
export function readTyped<T extends TypedWidgetType>(type: T, content: string): { data: TypedContent[T] } | { error: string } {
  try {
    return { data: JSON.parse(cleanContent(type, content)) as TypedContent[T] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Apply a JSON merge patch (RFC 7386) to typed content: objects merge, `null`
 * removes a key, other values (arrays too) replace. Returns the JSON text to store.
 */
export function patchContent(type: TypedWidgetType, content: string, patch: unknown): string {
  const current = readTyped(type, content);
  if ("error" in current) throw new Error(`The current content is not valid, so it cannot be patched. Send the full content. (${current.error})`);
  return cleanContent(type, mergePatch(current.data, patch));
}

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** The JSON shape of each type, for error messages and tool descriptions. */
export const SHAPES: Record<TypedWidgetType, string> = {
  heading: 'Shape: {"text": "Sales", "level": 2}. level is 1, 2 or 3.',
  metric:
    'Shape: {"value": 1250, "label": "Orders", "unit": "€", "delta": 3.2, "better": "up", "trend": [980, 1100, 1250]}. Only value and label are required. value and delta are numbers or short text.',
  chart:
    'Shape: a Vega-Lite spec with inline data, e.g. {"mark": "bar", "data": {"values": [{"a": "x", "b": 3}]}, "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}}}. No URLs: no data.url, no images, no links.',
  table: 'Shape: {"columns": ["Name", "Count"], "rows": [["A", 3], ["B", 5]]}. A row can also be an object with the column names as keys.',
};

const CLEAN: { [T in TypedWidgetType]: (d: Record<string, unknown>) => TypedContent[T] } = {
  heading(d) {
    const text = shortText(d.text, "Heading text", TYPED_LIMITS.headingText, true);
    const level = d.level === undefined ? 2 : d.level;
    if (level !== 1 && level !== 2 && level !== 3) throw new Error("Heading level must be 1, 2 or 3.");
    return { text, level };
  },

  metric(d) {
    const out: MetricContent = { value: numberOrText(d.value, "Metric value", true)!, label: shortText(d.label, "Metric label", TYPED_LIMITS.metricText, true) };
    if (d.unit !== undefined) out.unit = shortText(d.unit, "Metric unit", 20, false);
    const delta = numberOrText(d.delta, "Metric delta", false);
    if (delta !== undefined) out.delta = delta;
    if (d.better !== undefined) {
      if (d.better !== "up" && d.better !== "down") throw new Error('Metric "better" must be "up" or "down".');
      out.better = d.better;
    }
    if (d.trend !== undefined) {
      if (!Array.isArray(d.trend)) throw new Error("Metric trend must be an array of numbers.");
      if (d.trend.length > TYPED_LIMITS.trend) throw new Error(`Metric trend can have at most ${TYPED_LIMITS.trend} values.`);
      if (!d.trend.every((v) => typeof v === "number" && Number.isFinite(v))) throw new Error("Metric trend must contain only numbers.");
      out.trend = d.trend as number[];
    }
    return out;
  },

  chart(d) {
    const size = JSON.stringify(d).length;
    if (size > TYPED_LIMITS.chartSpec) throw new Error(`The chart spec is too large (${size} characters, at most ${TYPED_LIMITS.chartSpec}). Aggregate the data first.`);
    checkSpec(d, [], 0);
    if (!hasMark(d)) throw new Error('A chart needs a Vega-Lite "mark", or a "layer", "concat", "facet" or "repeat" of marks.');
    return d;
  },

  table(d) {
    if (!Array.isArray(d.columns) || d.columns.length === 0) throw new Error("A table needs columns: an array of column names.");
    if (d.columns.length > TYPED_LIMITS.tableColumns) throw new Error(`A table can have at most ${TYPED_LIMITS.tableColumns} columns.`);
    const columns = d.columns.map((c, i) => shortText(c, `Column ${i + 1}`, 200, false));
    if (!Array.isArray(d.rows)) throw new Error("A table needs rows: an array of rows.");
    if (d.rows.length > TYPED_LIMITS.tableRows) throw new Error(`A table can have at most ${TYPED_LIMITS.tableRows} rows. Aggregate or filter the data first.`);
    const rows = d.rows.map((r, i) => {
      let cells: unknown[];
      if (Array.isArray(r)) {
        if (r.length > columns.length) throw new Error(`Row ${i + 1} has ${r.length} cells, but the table has ${columns.length} columns.`);
        cells = columns.map((_, j) => r[j]);
      } else if (isPlainObject(r)) {
        cells = columns.map((c) => r[c]);
      } else throw new Error(`Row ${i + 1} must be an array of cells or an object.`);
      return cells.map((v) => cell(v, i));
    });
    return { columns, rows };
  },
};

function cell(v: unknown, row: number): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`Row ${row + 1} has a number that is not finite.`);
    return v;
  }
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.length > TYPED_LIMITS.cellText) throw new Error(`Row ${row + 1} has a cell longer than ${TYPED_LIMITS.cellText} characters.`);
    return v;
  }
  throw new Error(`Row ${row + 1}: a cell must be text, a number, true, false or null.`);
}

function shortText(v: unknown, what: string, max: number, required: boolean): string {
  if (v === undefined && !required) return "";
  if (typeof v !== "string") throw new Error(`${what} must be text.`);
  const t = v.trim();
  if (required && !t) throw new Error(`${what} must not be empty.`);
  if (t.length > max) throw new Error(`${what} can have at most ${max} characters.`);
  return t;
}

function numberOrText(v: unknown, what: string, required: boolean): number | string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${what} is required.`);
    return undefined;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${what} must be a finite number.`);
    return v;
  }
  if (typeof v === "string") return shortText(v, what, TYPED_LIMITS.metricText, required);
  throw new Error(`${what} must be a number or text.`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Chart specs ----------------------------------------------------------------
//
// A chart spec must not make a browser load anything. Vega-Lite loads data
// from `data.url`, images from the `url` channel, and opens links from the
// `href` channel. `usermeta.embedOptions` changes the options of vega-embed.
// The app also renders charts in a sandbox with no network access; these
// checks give the agent a clear error before that.

/** Keys that load or open a URL, or change how the chart is embedded. */
const BLOCKED_KEYS = new Set(["url", "href", "usermeta", "loader", "baseURL"]);
/** Text that is a URL a browser can load or open, or `//host`. */
const URL_LIKE = /^\s*(?:(?:https?|wss?|ftp|file|data|blob|javascript|vbscript|mailto):|\/\/)/i;
/** The `$schema` value may be the Vega-Lite schema. It is never loaded. */
const SCHEMA = /^https:\/\/vega\.github\.io\/schema\/vega-lite\/v\d+(\.\d+)*\.json$/;

function checkSpec(v: unknown, path: string[], depth: number) {
  if (depth > TYPED_LIMITS.chartDepth) throw new Error("The chart spec is nested too deeply.");
  const where = () => (path.length ? path.join(".") : "the spec");
  if (typeof v === "string") {
    if (URL_LIKE.test(v)) throw new Error(`Charts can use only inline data. ${where()} looks like a URL: "${v.slice(0, 80)}".`);
    return;
  }
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`${where()} is not a finite number.`);
  if (Array.isArray(v)) {
    v.forEach((x, i) => checkSpec(x, [...path, String(i)], depth + 1));
    return;
  }
  if (!isPlainObject(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (k === "$schema" && path.length === 0) {
      if (typeof x !== "string" || !SCHEMA.test(x)) throw new Error('"$schema" must be a Vega-Lite schema URL, e.g. https://vega.github.io/schema/vega-lite/v6.json. You can leave it out.');
      continue;
    }
    if (BLOCKED_KEYS.has(k)) {
      const hint = k === "url" && path.at(-1) === "data" ? ' Put the rows in "data": {"values": [...]}.' : "";
      throw new Error(`Charts can use only inline data: "${[...path, k].join(".")}" is not allowed.${hint}`);
    }
    checkSpec(x, [...path, k], depth + 1);
  }
}

function hasMark(d: Record<string, unknown>): boolean {
  return ["mark", "layer", "concat", "hconcat", "vconcat", "facet", "repeat", "spec"].some((k) => d[k] !== undefined);
}

// Summaries ------------------------------------------------------------------

/** One short readable line for typed content. */
export function summariseTyped(type: TypedWidgetType, content: string): string {
  const r = readTyped(type, content);
  if ("error" in r) return `(not valid: ${r.error})`;
  switch (type) {
    case "heading": {
      const h = r.data as HeadingContent;
      return `H${h.level}: ${h.text}`;
    }
    case "metric": {
      const m = r.data as MetricContent;
      const value = `${m.value}${m.unit ? ` ${m.unit}` : ""}`;
      const delta = m.delta === undefined ? "" : typeof m.delta === "number" ? ` (${m.delta > 0 ? "+" : ""}${m.delta})` : ` (${m.delta})`;
      const trend = m.trend?.length ? `, trend of ${m.trend.length}` : "";
      return `${m.label}: ${value}${delta}${trend}`;
    }
    case "chart": {
      const c = r.data as ChartContent;
      const mark = markName(c);
      const rows = countRows(c);
      const title = typeof c.title === "string" ? c.title : isPlainObject(c.title) && typeof c.title.text === "string" ? c.title.text : typeof c.description === "string" ? c.description : "";
      return [`${mark} chart`, rows !== null ? `${rows} rows` : "", title].filter(Boolean).join(", ");
    }
    case "table": {
      const t = r.data as TableContent;
      const cols = t.columns.length > 6 ? `${t.columns.slice(0, 6).join(", ")}, …` : t.columns.join(", ");
      return `table, ${t.columns.length} columns (${cols}), ${t.rows.length} rows`;
    }
  }
}

function markName(c: Record<string, unknown>): string {
  const m = c.mark;
  if (typeof m === "string") return m;
  if (isPlainObject(m) && typeof m.type === "string") return m.type;
  if (Array.isArray(c.layer)) return "layered";
  return "composite";
}

function countRows(c: Record<string, unknown>): number | null {
  const d = c.data;
  if (isPlainObject(d) && Array.isArray(d.values)) return d.values.length;
  if (isPlainObject(c.datasets)) return Object.values(c.datasets).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  return null;
}

/** Starting content for a new typed widget that a user adds. */
export const STARTER_CONTENT: Record<TypedWidgetType, string> = {
  heading: JSON.stringify({ text: "New section", level: 2 }),
  metric: JSON.stringify({ value: 0, label: "New metric", trend: [] }),
  chart: JSON.stringify({
    mark: "bar",
    data: { values: [{ category: "A", amount: 4 }, { category: "B", amount: 7 }, { category: "C", amount: 3 }] },
    encoding: { x: { field: "category", type: "nominal" }, y: { field: "amount", type: "quantitative" } },
  }),
  table: JSON.stringify({ columns: ["Name", "Value"], rows: [["A", 1], ["B", 2]] }),
};
