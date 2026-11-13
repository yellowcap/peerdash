// Views of the typed widgets: heading, metric, chart and table. The content is
// JSON; core checks it. Content that is not valid (for example from an old
// peer) shows an error, never a crash.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  readTyped,
  type MapContent,
  type MapContext,
  type Cell,
  type ChartContent,
  type HeadingContent,
  type MetricContent,
  type TableContent,
  type TypedWidgetType,
  type Widget,
} from "@peerdash/core";
import { chartSrcdoc, fitSpec, withContext } from "./chart";
import { frameFeedback } from "./frame";
import { MapFrame } from "./MapFrame";
import { useCanvas, useDark, useMapContext } from "./hooks";

/** Where a widget renders. On a page it is as tall as its content; on a canvas and in a grid it fills its box. */
export type Where = "canvas" | "page" | "grid";

export const KIND_LABEL: Record<Widget["type"], string> = {
  note: "Note",
  html: "HTML",
  heading: "Heading",
  metric: "Metric",
  chart: "Chart",
  table: "Table",
  map: "Map",
};

/** The body of a typed widget. */
export function TypedBody({ widget: w, where }: { widget: Widget & { type: TypedWidgetType }; where: Where }) {
  const allowKey = w.allow.join(" ");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const r = useMemo(() => readTyped(w.type, w.content, w.allow), [w.type, w.content, allowKey]);
  if ("error" in r) return <div className="typed-error">This {KIND_LABEL[w.type].toLowerCase()} has content that is not valid: {r.error}</div>;
  switch (w.type) {
    case "heading":
      return <HeadingView widget={w} data={r.data as HeadingContent} where={where} />;
    case "metric":
      return <MetricView data={r.data as MetricContent} />;
    case "table":
      return <TableView data={r.data as TableContent} where={where} />;
    case "chart":
      return <ChartView id={w.id} spec={r.data as ChartContent} where={where} fallbackHeight={w.h} linked={w.linked} />;
    case "map":
      return <MapWidgetView widget={w} data={r.data as MapContent} where={where} />;
  }
}

/** A map widget. A linked map follows the shared extent. */
function MapWidgetView({ widget: w, data, where }: { widget: Widget; data: MapContent; where: Where }) {
  const { doc } = useCanvas();
  const ctx = useMapContext(doc);
  return (
    <div className={`map-widget map-${where}`} style={where === "page" ? { height: Math.min(Math.max(w.h, 240), 640) } : undefined}>
      <MapFrame id={w.id} content={data} allow={w.allow} follow={w.linked ? (ctx.bbox ?? null) : null} />
    </div>
  );
}

/** Heading. Double-click to edit the text in place. */
function HeadingView({ widget: w, data, where }: { widget: Widget; data: HeadingContent; where: Where }) {
  const { doc, author } = useCanvas();
  const [editing, setEditing] = useState(false);
  // On a page, the page title is <h1>, so a level 1 heading is <h2>.
  const Tag = (where === "page" ? `h${data.level + 1}` : `h${data.level}`) as "h2";
  const save = (text: string) => {
    setEditing(false);
    const t = text.trim();
    if (t && t !== data.text) doc.patchContent(w.id, { text: t }, author);
  };
  return (
    <div className={`heading-view heading-${data.level} heading-${where}`} onDoubleClick={() => setEditing(true)}>
      {editing ? (
        <input
          className="heading-input nodrag"
          defaultValue={data.text}
          autoFocus
          aria-label="Heading text"
          onBlur={(e) => save(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <Tag>{data.text}</Tag>
      )}
    </div>
  );
}

const fmt = (v: number | string) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v);

/** KPI tile: value, label, change and a sparkline. */
function MetricView({ data: m }: { data: MetricContent }) {
  const dir = m.delta === undefined ? 0 : typeof m.delta === "number" ? Math.sign(m.delta) : /^\s*[-−–]/.test(m.delta) ? -1 : /^\s*\+/.test(m.delta) ? 1 : 0;
  const good = dir === 0 ? "flat" : (dir > 0) === ((m.better ?? "up") === "up") ? "good" : "bad";
  const delta = m.delta === undefined ? null : typeof m.delta === "number" ? `${m.delta > 0 ? "+" : ""}${fmt(m.delta)}` : m.delta;
  return (
    <div className="metric">
      <div className="metric-label">{m.label}</div>
      <div className="metric-value">
        {fmt(m.value)}
        {m.unit && <span className="metric-unit"> {m.unit}</span>}
      </div>
      {delta !== null && (
        <div className={`metric-delta ${good}`}>
          <span aria-hidden="true">{dir > 0 ? "▲ " : dir < 0 ? "▼ " : ""}</span>
          {delta}
        </div>
      )}
      {m.trend && m.trend.length > 1 && <Sparkline values={m.trend} />}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`).join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`Trend from ${fmt(values[0])} to ${fmt(values.at(-1)!)}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Sort = { col: number; dir: 1 | -1 } | null;

function compareCells(a: Cell, b: Cell): number {
  // Empty cells go last in both directions; see the caller.
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Table. Click a column header to sort; click again to reverse. */
function TableView({ data: t, where }: { data: TableContent; where: Where }) {
  const [sort, setSort] = useState<Sort>(null);
  const rows = useMemo(() => {
    if (!sort) return t.rows;
    const { col, dir } = sort;
    return [...t.rows].sort((x, y) => {
      const a = x[col];
      const b = y[col];
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
      return dir * compareCells(a, b);
    });
  }, [t.rows, sort]);
  const numeric = t.columns.map((_, j) => t.rows.some((r) => typeof r[j] === "number") && t.rows.every((r) => r[j] === null || typeof r[j] === "number"));
  const click = (col: number) => setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  return (
    <div className={`table-view${where === "canvas" ? " nowheel" : ""}`}>
      <table>
        <thead>
          <tr>
            {t.columns.map((c, j) => (
              <th key={j} aria-sort={sort?.col === j ? (sort.dir === 1 ? "ascending" : "descending") : undefined} className={numeric[j] ? "num" : undefined}>
                <button className="nodrag" onClick={() => click(j)}>
                  {c}
                  <span className="sort-mark" aria-hidden="true">
                    {sort?.col === j ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className={numeric[j] ? "num" : undefined}>
                  {v === null ? "" : typeof v === "number" ? fmt(v) : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted table-empty">No rows.</p>}
    </div>
  );
}

const MIN_CHART = 60;
const MAX_CHART = 1600;

/** A chart in a sandboxed iframe; see chart.ts. */
function ChartView({ id, spec, where, fallbackHeight, linked }: { id: string; spec: ChartContent; where: Where; fallbackHeight: number; linked: boolean }) {
  const { doc } = useCanvas();
  const ref = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const dark = useDark();
  const fill = where !== "page";
  const ctx = useMapContext(doc);
  const shared: MapContext | null = linked ? ctx : null;
  const message = useMemo(() => ({ __peerdash: true, type: "chart", spec: withContext(fitSpec(spec, fill), shared), fill, dark }), [spec, fill, dark, shared]);
  const reported = useSyncExternalStore(frameFeedback.subscribe, () => frameFeedback.contentHeight(id));

  useEffect(() => {
    let live = true;
    chartSrcdoc().then((s) => live && setSrcdoc(s));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!srcdoc) return;
    const post = () => ref.current?.contentWindow?.postMessage(message, "*");
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data?.__peerdash) return;
      const m = e.data;
      if (m.type === "ready") post();
      else if (m.type === "rendered") frameFeedback.reset(id);
      else if (m.type === "error") frameFeedback.add(id, "error", String(m.text));
      else if (m.type === "size") frameFeedback.size(id, Number(m.width) || 0, Number(m.height) || 0, Number(m.contentHeight) || 0);
    };
    window.addEventListener("message", onMessage);
    post();
    return () => window.removeEventListener("message", onMessage);
  }, [srcdoc, message, id]);

  useEffect(() => () => frameFeedback.remove(id), [id]);

  const errors = useSyncExternalStore(frameFeedback.subscribe, () => frameFeedback.get(id)?.errors.at(-1));
  const height = fill ? undefined : reported > 0 ? Math.min(MAX_CHART, Math.max(MIN_CHART, reported)) : Math.min(fallbackHeight, 320);
  return (
    <div className={`chart-view chart-${where}`} style={height ? { height } : undefined}>
      {srcdoc ? (
        <iframe ref={ref} className="chart-frame nodrag nowheel" title={`Chart ${id}`} sandbox="allow-scripts" srcDoc={srcdoc} />
      ) : (
        <div className="muted chart-loading">Loading chart…</div>
      )}
      {errors && <div className="typed-error chart-error">{errors}</div>}
    </div>
  );
}
