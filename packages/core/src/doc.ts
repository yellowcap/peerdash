// One dashboard = one Loro document.
//
// - `meta` (map): id, title, createdAt, schemaVersion, layout
// - `widgets` (map): widgetId → map { type, title, content, allow, createdBy, state (map), place (map), x, y, w, h, z }
//   - `place` holds one mergeable map for each layout: `canvas` {x, y, w, h, z},
//     `page` {order, width}, `grid` {order, span, rows}, `map` {slot, order, lngLat, corner}.
//     Mergeable maps have a fixed id, so peers that make one at the same time
//     get the same map, and their edits merge.
//   - The top-level x, y, w, h, z are the schema 1 canvas fields. Schema 2 peers
//     read `place.canvas` first and use them as a fallback. Schema 2 peers also
//     write them, so schema 1 peers (old plugin bundles) still show positions.
// - `edges` (map): edgeId → map { from, to, label }
// - `comments` (map): commentId → map { widgetId, text, author, createdAt, resolved }
// - `context` (map): the shared map extent and time, { bbox, datetime }. Both
//   are optional. Widgets with `linked: true` follow them.
//
// Every mutation is a named method that commits exactly one Loro change. The
// commit message is `{"a": author, "k": action, "v": values}`, so the history
// says who did what, and survives merges. The UI and the agent peer never write
// to Loro directly.

import { LoroDoc, LoroMap, VersionVector } from "loro-crdt";
import { compareKeys, compareOrdered, isOrderKey, keysBetween } from "./order";
import { cleanContent, isTypedWidget, mergePatch, patchContent, TYPED_WIDGETS } from "./typed";
import { allowForMap, cleanBBox, cleanDatetime, type BBox, type MapContext } from "./map";

export const SCHEMA_VERSION = 2;

export const LAYOUTS = ["canvas", "page", "grid", "map"] as const;
export type Layout = (typeof LAYOUTS)[number];
export type OrderedLayout = Exclude<Layout, "canvas">;
export const PAGE_WIDTHS = ["text", "wide", "full"] as const;
export type PageWidth = (typeof PAGE_WIDTHS)[number];
export const MAP_SLOTS = ["panel", "overlay", "marker"] as const;
export type MapSlot = (typeof MAP_SLOTS)[number];
export const MAP_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type MapCorner = (typeof MAP_CORNERS)[number];

export const WIDGET_TYPES = ["note", "html", ...TYPED_WIDGETS] as const;
/** `note` and `html` hold text. The typed widgets (`heading`, `metric`, `chart`, `table`, `map`) hold JSON; see typed.ts. */
export type WidgetType = (typeof WIDGET_TYPES)[number];

export interface CanvasPlace {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}
export interface PagePlace {
  order: string;
  width: PageWidth;
}
export interface GridPlace {
  order: string;
  /** Columns, 1–12. */
  span: number;
  /** Rows, 1–6. */
  rows: number;
}
export interface MapPlace {
  slot: MapSlot;
  order: string;
  /** [longitude, latitude]. Only a marker has one. */
  lngLat?: [number, number];
  /** The corner of an overlay. Default "top-right". Kept when the slot changes. */
  corner?: MapCorner;
}
/** The place of a widget in each layout. A missing entry means no place in that layout. */
export interface Places {
  canvas: CanvasPlace;
  page?: PagePlace;
  grid?: GridPlace;
  map?: MapPlace;
}
export interface PlacePatches {
  canvas: Partial<CanvasPlace>;
  page: Partial<PagePlace>;
  grid: Partial<GridPlace>;
  /** `lngLat: null` removes the position. */
  map: Partial<Omit<MapPlace, "lngLat">> & { lngLat?: [number, number] | null };
}
/** A spot in the order of a page, grid or map layout. */
export type OrderTarget = "start" | "end" | { before: string } | { after: string };

export const CANVAS_LIMITS = { minW: 120, minH: 60, maxSize: 8000, maxPos: 1_000_000 };
export const GRID_DEFAULT = { span: 4, rows: 2 };
export const GRID_LIMITS = { span: 12, rows: 6 };

export interface Widget {
  id: string;
  type: WidgetType;
  /** `x`, `y`, `w`, `h`, `z` are the canvas place (`place.canvas`). */
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  title: string;
  /** Markdown for `note`, an HTML document or fragment for `html`, JSON for a typed widget. */
  content: string;
  /** Network origins an `html` or `map` widget may load from (empty = none). */
  allow: string[];
  /** The widget follows the dashboard's map context (extent and time). */
  linked: boolean;
  createdBy: string;
  place: Places;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface Comment {
  id: string;
  widgetId: string;
  text: string;
  author: string;
  /** Unix milliseconds, from the author's clock. */
  createdAt: number;
  resolved: boolean;
}

export const MAX_COMMENT_LENGTH = 2000;

export type WidgetInput = Partial<Omit<Widget, "id" | "createdBy" | "place">> & {
  type: WidgetType;
  /** Places in the page, grid and map layouts. Missing fields get defaults; a missing order goes to the end. */
  place?: { page?: PlacePatches["page"]; grid?: PlacePatches["grid"]; map?: PlacePatches["map"] };
  /** A spot in the order of a layout, e.g. `{ page: { after: id } }`. Wins over `place.<layout>.order`. */
  at?: Partial<Record<OrderedLayout, OrderTarget>>;
};
export type WidgetPatch = Partial<Pick<Widget, "x" | "y" | "w" | "h" | "z" | "title" | "content" | "allow" | "linked">>;

/** One entry of the change log. */
export interface Change {
  author: string;
  action: string;
  values: Record<string, unknown>;
  /** Unix seconds, as recorded by the author's clock. */
  at: number;
  peer: string;
}

export const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  note: { w: 280, h: 180 },
  html: { w: 480, h: 320 },
  heading: { w: 480, h: 80 },
  metric: { w: 220, h: 150 },
  chart: { w: 480, h: 320 },
  table: { w: 480, h: 300 },
  map: { w: 520, h: 380 },
};

/** The grid size of a new widget, by type. A heading is not in the grid; its size is used only for old data. */
export const GRID_SIZE: Record<WidgetType, { span: number; rows: number }> = {
  note: { span: 4, rows: 2 },
  html: { span: 6, rows: 3 },
  heading: { span: 12, rows: 1 },
  metric: { span: 3, rows: 2 },
  chart: { span: 6, rows: 3 },
  table: { span: 6, rows: 3 },
  map: { span: 6, rows: 4 },
};

/**
 * Widget types that a layout does not show. The grid has no `heading`: a
 * dashboard grid has no sections, and a heading in a cell of a dense grid
 * would not stay above the cells that follow it. Use a widget title, or a page.
 *
 * Core refuses to add these widgets, or to move or resize them, in that layout.
 * Widgets that exist already (for example when a page changes to a grid) stay
 * in the document with all their places. The layout does not show them, and
 * they come back when the layout changes again.
 *
 * The map layout hides no type. Its rule is about one widget, not a type: the
 * first `map` in its order is the background map (see `backgroundMap`). Other
 * maps show in their slot, as small maps.
 */
export const HIDDEN_TYPES: Partial<Record<Layout, readonly WidgetType[]>> = { grid: ["heading"] };

/** True when a layout shows widgets of this type. */
export function fitsLayout(type: WidgetType, layout: Layout): boolean {
  return !HIDDEN_TYPES[layout]?.includes(type);
}

function notInLayout(type: WidgetType, layout: Layout): string {
  return `The ${layout} layout has no ${type} widgets.${type === "heading" && layout === "grid" ? " Give each widget a title instead, or use a page for sections." : ""}`;
}

const WIDGET_FIELDS = ["type", "title", "content", "allow", "createdBy", "linked"] as const;
const CANVAS_FIELDS = ["x", "y", "w", "h", "z"] as const;
const ORDERED_LAYOUTS = ["page", "grid", "map"] as const;

export function newId(): string {
  return crypto.randomUUID();
}

export function isWidgetType(v: unknown): v is WidgetType {
  return (WIDGET_TYPES as readonly unknown[]).includes(v);
}

/**
 * Check content for a widget type. Typed content must be valid JSON for the
 * type; it is stored as compact JSON. A map may load only from `allow`.
 */
export function contentFor(type: WidgetType, content: string, allow: readonly string[] = []): string {
  if (typeof content !== "string") throw new Error("Content must be text.");
  return isTypedWidget(type) ? cleanContent(type, content, allow) : content;
}

export function isLayout(v: unknown): v is Layout {
  return (LAYOUTS as readonly unknown[]).includes(v);
}

export class CanvasDoc {
  readonly loro: LoroDoc;

  constructor(loro: LoroDoc = new LoroDoc()) {
    this.loro = loro;
    // Commit timestamps make the change log readable.
    this.loro.setRecordTimestamp(true);
  }

  static create(title: string, author: string, id: string = newId(), layout: Layout = "canvas"): CanvasDoc {
    if (!isLayout(layout)) throw new Error(`Unknown layout ${String(layout)}`);
    const doc = new CanvasDoc();
    const meta = doc.loro.getMap("meta");
    meta.set("id", id);
    meta.set("title", title);
    meta.set("createdAt", Date.now());
    meta.set("schemaVersion", SCHEMA_VERSION);
    meta.set("layout", layout);
    doc.commit(author, "create", { title, layout });
    return doc;
  }

  static fromSnapshot(bytes: Uint8Array): CanvasDoc {
    const loro = new LoroDoc();
    loro.import(bytes);
    return new CanvasDoc(loro);
  }

  /** Empty until the first sync, when this browser joined from a link. */
  get id(): string {
    return (this.loro.getMap("meta").get("id") as string | undefined) ?? "";
  }

  get ready(): boolean {
    return this.id !== "";
  }

  get title(): string {
    return (this.loro.getMap("meta").get("title") as string | undefined) ?? "";
  }

  /** The layout of the dashboard. Schema 1 documents have none, so they are canvases. */
  get layout(): Layout {
    const l = this.loro.getMap("meta").get("layout");
    return isLayout(l) ? l : "canvas";
  }

  get schemaVersion(): number {
    return Number(this.loro.getMap("meta").get("schemaVersion") ?? 1);
  }

  /** All widgets, back to front (by canvas `z`, then id). */
  widgets(): Widget[] {
    const all = this.loro.getMap("widgets").toJSON() as Record<string, Record<string, unknown>>;
    return Object.entries(all)
      .map(([id, w]) => toWidget(id, w))
      .sort((a, b) => a.z - b.z || compareKeys(a.id, b.id));
  }

  /**
   * Widgets in reading order for a layout (default: the current layout).
   * Canvas: top to bottom, then left to right. Page, grid and map: by order
   * key, then by id. Widgets with no place in the layout come last, in canvas
   * reading order.
   */
  readingOrder(layout: Layout = this.layout): Widget[] {
    const all = this.widgets().sort(compareCanvas);
    if (layout === "canvas") return all;
    return all
      .map((w, i) => ({ w, i, id: w.id, order: w.place[layout]?.order }))
      .sort((a, b) => (a.order === undefined && b.order === undefined ? a.i - b.i : compareOrdered(a, b)))
      .map((x) => x.w);
  }

  /** The widgets that a layout shows, in reading order. The grid does not show headings; see `HIDDEN_TYPES`. */
  widgetsIn(layout: Layout = this.layout): Widget[] {
    return this.readingOrder(layout).filter((w) => fitsLayout(w.type, layout));
  }

  /**
   * The background map of the map layout: the first `map` widget in the map
   * order. Its slot does not matter. Null when the dashboard has no map.
   */
  backgroundMap(): Widget | null {
    return this.readingOrder("map").find((w) => w.type === "map") ?? null;
  }

  /** The shared map context. Fields that are missing or not valid are left out. */
  context(): MapContext {
    const c = this.loro.getMap("context").toJSON() as Record<string, unknown>;
    const out: MapContext = {};
    try {
      if (c.bbox !== undefined) out.bbox = cleanBBox(c.bbox);
    } catch {
      // From a newer or broken peer: ignore.
    }
    try {
      if (c.datetime !== undefined) out.datetime = cleanDatetime(c.datetime);
    } catch {
      // As above.
    }
    return out;
  }

  widget(id: string): Widget | null {
    const m = this.widgetMap(id);
    return m ? toWidget(id, m.toJSON()) : null;
  }

  edges(): Edge[] {
    const all = this.loro.getMap("edges").toJSON() as Record<string, Record<string, unknown>>;
    return Object.entries(all).map(([id, e]) => ({
      id,
      from: String(e.from ?? ""),
      to: String(e.to ?? ""),
      label: String(e.label ?? ""),
    }));
  }

  widgetState(id: string): Record<string, unknown> {
    const state = this.widgetMap(id)?.get("state");
    return state instanceof LoroMap ? (state.toJSON() as Record<string, unknown>) : {};
  }

  // Mutations ----------------------------------------------------------------

  setTitle(title: string, author: string) {
    this.loro.getMap("meta").set("title", title);
    this.commit(author, "title", { title });
  }

  /**
   * Change the layout. The places in the other layouts stay. Widgets with no
   * place in the new layout get one at the end, in canvas reading order.
   */
  setLayout(layout: Layout, author: string) {
    if (!isLayout(layout)) throw new Error(`Unknown layout ${String(layout)}. Use one of: ${LAYOUTS.join(", ")}.`);
    this.loro.getMap("meta").set("layout", layout);
    if (layout !== "canvas") {
      const missing = this.readingOrder(layout).filter((w) => !w.place[layout]);
      if (missing.length) {
        const keys = keysBetween(this.lastKey(layout), null, missing.length);
        missing.forEach((w, i) => this.writePlace(w.id, layout, { ...defaultPlace(layout, w.type), order: keys[i] }));
      }
    }
    this.commit(author, "layout", { layout });
  }

  createWidget(input: WidgetInput, author: string): string {
    if (!isWidgetType(input.type)) throw new Error(`Unknown widget type ${String(input.type)}. Use one of: ${WIDGET_TYPES.join(", ")}.`);
    if (!fitsLayout(input.type, this.layout)) throw new Error(notInLayout(input.type, this.layout));
    // A map with the default basemap needs its origin in allow; add it, so the list shows it.
    const allow = input.type === "map" ? allowForMap(input.content ?? "", input.allow ?? []) : (input.allow ?? []);
    const content = contentFor(input.type, input.content ?? "", allow);
    const id = newId();
    const size = DEFAULT_SIZE[input.type];
    const top = this.widgets().reduce((z, w) => Math.max(z, w.z), 0);
    // Check every place first, so that a bad input writes nothing.
    const canvas = cleanCanvas({ x: input.x ?? 0, y: input.y ?? 0, w: input.w ?? size.w, h: input.h ?? size.h, z: input.z ?? top + 1 });
    const rekeys: [OrderedLayout, string, string][] = [];
    const others = ORDERED_LAYOUTS.map((layout) => {
      // Fields set to undefined keep their defaults.
      const given = Object.fromEntries(Object.entries(input.place?.[layout] ?? {}).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
      const target = input.at?.[layout];
      let order = given.order ?? keysBetween(this.lastKey(layout), null, 1)[0];
      if (target) {
        const plan = this.planOrder(layout, target, id);
        order = plan.key;
        for (const [other, k] of plan.rekeys) rekeys.push([layout, other, k]);
      }
      const patch = { ...defaultPlace(layout, input.type), ...given, order };
      checkPlace(layout, patch, undefined);
      return [layout, patch] as const;
    });
    const m = this.loro.getMap("widgets").setContainer(id, new LoroMap());
    const values = {
      type: input.type,
      title: input.title ?? "",
      content,
      allow,
      createdBy: author,
      linked: input.linked === true,
    };
    for (const k of WIDGET_FIELDS) m.set(k, values[k]);
    m.setContainer("state", new LoroMap());
    this.writePlace(id, "canvas", canvas);
    for (const [layout, patch] of others) this.writePlace(id, layout, patch as PlacePatches[typeof layout]);
    for (const [layout, other, k] of rekeys) this.writeOrder(other, layout, k);
    this.commit(author, "add", { id, type: input.type, title: values.title });
    return id;
  }

  updateWidget(id: string, patch: WidgetPatch, author: string) {
    const m = this.requireWidget(id);
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return;
    if (patch.linked !== undefined && typeof patch.linked !== "boolean") throw new Error("linked must be true or false.");
    const type = m.get("type");
    if (type === "map" && (patch.content !== undefined || patch.allow !== undefined)) {
      // Check the map content against the allow list that it will have.
      let allow = patch.allow ?? toWidget(id, m.toJSON()).allow;
      if (patch.content !== undefined) allow = allowForMap(patch.content, allow);
      const content = contentFor("map", patch.content ?? String(m.get("content") ?? ""), allow);
      const set = (k: string, v: string | string[]) => {
        const i = fields.findIndex(([f]) => f === k);
        if (i >= 0) fields[i] = [k, v];
        else fields.push([k, v]);
      };
      if (patch.content !== undefined) set("content", content);
      if (allow.join("\n") !== toWidget(id, m.toJSON()).allow.join("\n")) set("allow", allow);
    } else if (patch.content !== undefined) {
      fields.splice(fields.findIndex(([k]) => k === "content"), 1, ["content", isWidgetType(type) ? contentFor(type, patch.content) : patch.content]);
    }
    const canvas: Partial<CanvasPlace> = {};
    const rest: [string, unknown][] = [];
    for (const [k, v] of fields) {
      if ((CANVAS_FIELDS as readonly string[]).includes(k)) canvas[k as keyof CanvasPlace] = v as number;
      else rest.push([k, v]);
    }
    if (Object.keys(canvas).length) this.writePlace(id, "canvas", canvas);
    for (const [k, v] of rest) m.set(k, v as never);
    this.commit(author, "edit", { id, fields: fields.map(([k]) => k) });
  }

  /**
   * Change part of the content of a typed widget with a JSON merge patch:
   * objects merge, `null` removes a key, arrays and other values replace.
   * The result must be valid; else this throws and writes nothing. A map
   * can get a new allow list in the same change (`newAllow`).
   */
  patchContent(id: string, patch: Record<string, unknown>, author: string, newAllow?: string[]) {
    const m = this.requireWidget(id);
    const type = m.get("type");
    if (!isTypedWidget(type)) throw new Error(`Only heading, metric, chart, table and map widgets take a content patch. This widget is ${String(type)}.`);
    if (newAllow && type !== "map") throw new Error("Only a map takes an allow list with a content patch.");
    const before = toWidget(id, m.toJSON()).allow;
    const current = String(m.get("content") ?? "");
    let allow = before;
    let next: string;
    if (type === "map") {
      // A patch can switch to the default basemap: then its origin joins allow.
      allow = allowForMap(patchedMap(current, patch), newAllow ?? before);
      next = patchContent(type, current, patch, allow);
    } else next = patchContent(type, current, patch);
    const allowChanged = allow.join("\n") !== before.join("\n");
    m.set("content", next);
    if (allowChanged) m.set("allow", allow);
    this.commit(author, "edit", { id, fields: allowChanged ? ["content", "allow"] : ["content"], keys: Object.keys(patch) });
  }

  /** Move or resize widgets on the canvas. */
  moveWidgets(moves: { id: string; x: number; y: number; w?: number; h?: number }[], author: string) {
    if (moves.length === 0) return;
    for (const mv of moves) this.requireWidget(mv.id);
    for (const { id, x, y, w, h } of moves) this.writePlace(id, "canvas", { x, y, ...(w !== undefined && { w }), ...(h !== undefined && { h }) });
    this.commit(author, "move", { ids: moves.map((m) => m.id) });
  }

  /**
   * Change the place of a widget in one layout. Numbers are rounded and
   * clamped. A bad order key, width, slot or position throws and writes nothing.
   */
  setPlace<L extends Layout>(id: string, layout: L, patch: PlacePatches[L], author: string) {
    if (!isLayout(layout)) throw new Error(`Unknown layout ${String(layout)}`);
    this.requireFit(id, layout);
    this.writePlace(id, layout, patch);
    this.commit(author, "place", { id, layout, fields: Object.keys(patch) });
  }

  /** Move a widget to a spot in the order of a layout. Returns its new order key. */
  moveInOrder(id: string, layout: OrderedLayout, target: OrderTarget, author: string): string {
    this.requireFit(id, layout);
    const { key, rekeys } = this.planOrder(layout, target, id);
    for (const [other, k] of rekeys) this.writeOrder(other, layout, k);
    this.writeOrder(id, layout, key);
    this.commit(author, "order", { id, layout });
    return key;
  }

  deleteWidgets(ids: string[], author: string) {
    const widgets = this.loro.getMap("widgets");
    const edges = this.loro.getMap("edges");
    const gone = new Set(ids.filter((id) => widgets.get(id) !== undefined));
    if (gone.size === 0) return;
    for (const id of gone) widgets.delete(id);
    for (const e of this.edges()) if (gone.has(e.from) || gone.has(e.to)) edges.delete(e.id);
    const comments = this.loro.getMap("comments");
    for (const c of this.comments()) if (gone.has(c.widgetId)) comments.delete(c.id);
    this.commit(author, "delete", { ids: [...gone] });
  }

  connect(from: string, to: string, label: string, author: string): string {
    this.requireWidget(from);
    this.requireWidget(to);
    const id = newId();
    const m = this.loro.getMap("edges").setContainer(id, new LoroMap());
    m.set("from", from);
    m.set("to", to);
    m.set("label", label);
    this.commit(author, "connect", { id, from, to });
    return id;
  }

  disconnect(ids: string[], author: string) {
    const edges = this.loro.getMap("edges");
    for (const id of ids) edges.delete(id);
    this.commit(author, "disconnect", { ids });
  }

  /**
   * Change the shared map context in one commit. `null` removes a field;
   * fields left out stay. A bad value throws and writes nothing.
   */
  setContext(patch: { bbox?: BBox | null; datetime?: string | null }, author: string) {
    const ctx = this.loro.getMap("context");
    const writes: [string, unknown][] = [];
    if (patch.bbox !== undefined) writes.push(["bbox", patch.bbox === null ? null : cleanBBox(patch.bbox)]);
    if (patch.datetime !== undefined) writes.push(["datetime", patch.datetime === null || patch.datetime === "" ? null : cleanDatetime(patch.datetime)]);
    if (writes.length === 0) return;
    const now = this.context() as Record<string, unknown>;
    const changed = writes.filter(([k, v]) => JSON.stringify(now[k] ?? null) !== JSON.stringify(v));
    if (changed.length === 0) return;
    for (const [k, v] of changed) {
      if (v === null) ctx.delete(k);
      else ctx.set(k, v as never);
    }
    this.commit(author, "context", Object.fromEntries(changed));
  }

  /** Shared state of an html widget, written through the iframe bridge. */
  setWidgetState(id: string, key: string, value: unknown, author: string) {
    const m = this.requireWidget(id);
    let state = m.get("state");
    if (!(state instanceof LoroMap)) state = m.setContainer("state", new LoroMap());
    (state as LoroMap).set(key, value as never);
    this.commit(author, "state", { id, key });
  }

  // Comments -----------------------------------------------------------------

  /** Comments, oldest first; only those of one widget when `widgetId` is given. */
  comments(widgetId?: string): Comment[] {
    const all = this.loro.getMap("comments").toJSON() as Record<string, Record<string, unknown>>;
    return Object.entries(all)
      .map(([id, c]) => ({
        id,
        widgetId: String(c.widgetId ?? ""),
        text: String(c.text ?? ""),
        author: String(c.author ?? ""),
        createdAt: Number(c.createdAt ?? 0),
        resolved: c.resolved === true,
      }))
      .filter((c) => !widgetId || c.widgetId === widgetId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  addComment(widgetId: string, text: string, author: string): string {
    this.requireWidget(widgetId);
    const body = text.trim().slice(0, MAX_COMMENT_LENGTH);
    if (!body) throw new Error("A comment needs text.");
    const id = newId();
    const m = this.loro.getMap("comments").setContainer(id, new LoroMap());
    m.set("widgetId", widgetId);
    m.set("text", body);
    m.set("author", author);
    m.set("createdAt", Date.now());
    m.set("resolved", false);
    // The text goes into the log too, so peers see it in "changes since".
    this.commit(author, "comment", { id, widgetId, text: body.slice(0, 200) });
    return id;
  }

  resolveComment(id: string, resolved: boolean, author: string) {
    const m = this.loro.getMap("comments").get(id);
    if (!(m instanceof LoroMap)) throw new Error(`No comment with id ${id}`);
    m.set("resolved", resolved);
    this.commit(author, resolved ? "resolve" : "reopen", { id, widgetId: m.get("widgetId") });
  }

  deleteComment(id: string, author: string) {
    const comments = this.loro.getMap("comments");
    if (comments.get(id) === undefined) return;
    comments.delete(id);
    this.commit(author, "uncomment", { id });
  }

  // History ------------------------------------------------------------------

  /** Changes not covered by `since` (all changes when `since` is omitted), oldest first. */
  changesSince(since?: VersionVector): Change[] {
    const out: (Change & { lamport: number })[] = [];
    for (const [peer, changes] of this.loro.getAllChanges()) {
      const seen = since?.get(peer) ?? 0;
      for (const c of changes) {
        if (c.counter + c.length <= seen) continue;
        out.push({ ...parseMessage(c.message), at: c.timestamp, peer: String(peer), lamport: c.lamport });
      }
    }
    // Lamport order respects causality; timestamps are only seconds.
    return out.sort((a, b) => a.lamport - b.lamport).map(({ lamport: _, ...c }) => c);
  }

  // Sync ---------------------------------------------------------------------

  versionBytes(): Uint8Array {
    return this.loro.oplogVersion().encode();
  }

  version(): VersionVector {
    return this.loro.oplogVersion();
  }

  updatesSince(versionBytes: Uint8Array): Uint8Array {
    const from = versionBytes.length ? VersionVector.decode(versionBytes) : undefined;
    return this.loro.export({ mode: "update", from });
  }

  applyRemote(bytes: Uint8Array) {
    this.loro.import(bytes);
  }

  snapshot(): Uint8Array {
    return this.loro.export({ mode: "snapshot" });
  }

  /** Bytes of every local commit, for broadcasting to peers. */
  onLocalUpdate(handler: (bytes: Uint8Array) => void): () => void {
    return this.loro.subscribeLocalUpdates(handler);
  }

  /** Any change, local or remote. `remote` is true for imported updates. */
  subscribe(handler: (remote: boolean) => void): () => void {
    return this.loro.subscribe((e) => handler(e.by === "import"));
  }

  private commit(author: string, action: string, values: Record<string, unknown>) {
    // A schema 1 document becomes schema 2 on its first change by a schema 2
    // peer. There is no separate migration step: reads fall back to the schema
    // 1 fields. Peers that do this at the same time write the same value.
    if (this.ready && this.schemaVersion < SCHEMA_VERSION) this.loro.getMap("meta").set("schemaVersion", SCHEMA_VERSION);
    this.loro.commit({ message: JSON.stringify({ a: author, k: action, v: values }) });
  }

  /** The highest order key in a layout, or null when no widget has a place there. */
  private lastKey(layout: OrderedLayout): string | null {
    let last: string | null = null;
    for (const w of this.widgets()) {
      const k = w.place[layout]?.order;
      if (k !== undefined && (last === null || compareKeys(k, last) > 0)) last = k;
    }
    return last;
  }

  /**
   * An order key for a spot, and new keys for the widgets that must move to
   * make room. Widgets with the same key as the left neighbour (a tie from
   * concurrent inserts) get new keys after the new one, so the spot is exact.
   */
  private planOrder(layout: OrderedLayout, target: OrderTarget, moving: string): { key: string; rekeys: [string, string][] } {
    const placed = this.readingOrder(layout)
      .filter((w) => w.id !== moving && w.place[layout])
      .map((w) => ({ id: w.id, order: w.place[layout]!.order }));
    let i: number;
    if (target === "start") i = 0;
    else if (target === "end") i = placed.length;
    else {
      const before = "before" in target;
      const ref = before ? target.before : target.after;
      if (ref === moving) throw new Error("A widget cannot go before or after itself.");
      if (!this.widgetMap(ref)) throw new Error(`No widget with id ${ref}`);
      const idx = placed.findIndex((p) => p.id === ref);
      if (idx < 0) {
        // The reference widget has no place yet. Put it at the end, and this widget next to it.
        const [a, b] = keysBetween(placed.at(-1)?.order ?? null, null, 2);
        return before ? { key: a, rekeys: [[ref, b]] } : { key: b, rekeys: [[ref, a]] };
      }
      i = before ? idx : idx + 1;
    }
    const lo = i > 0 ? placed[i - 1].order : null;
    let j = i;
    while (lo !== null && j < placed.length && placed[j].order === lo) j++;
    const hi = j < placed.length ? placed[j].order : null;
    const keys = keysBetween(lo, hi, 1 + j - i);
    return { key: keys[0], rekeys: placed.slice(i, j).map((p, n) => [p.id, keys[n + 1]]) };
  }

  /** Write an order key, with a default place when the widget has none in the layout yet. No commit. */
  private writeOrder(id: string, layout: OrderedLayout, order: string) {
    const w = this.widget(id);
    this.writePlace(id, layout, w?.place[layout] ? { order } : { ...defaultPlace(layout, w?.type ?? "note"), order });
  }

  /** The widget must exist and the layout must show its type. */
  private requireFit(id: string, layout: Layout) {
    const type = this.requireWidget(id).get("type");
    if (isWidgetType(type) && !fitsLayout(type, layout)) throw new Error(notInLayout(type, layout));
  }

  /** Check and write a place, with no commit. Throws before any write when the result is not valid. */
  private writePlace<L extends Layout>(id: string, layout: L, patch: PlacePatches[L]) {
    const m = this.requireWidget(id);
    if (layout === "canvas") {
      const clean = cleanCanvas(patch as Partial<CanvasPlace>);
      const target = m.ensureMergeableMap("place").ensureMergeableMap("canvas");
      for (const [k, v] of Object.entries(clean)) {
        target.set(k, v);
        // Schema 1 peers read only the top-level fields.
        m.set(k, v);
      }
      return;
    }
    const current = toWidget(id, m.toJSON() as Record<string, unknown>).place[layout as OrderedLayout];
    const clean = checkPlace(layout as OrderedLayout, patch as Record<string, unknown>, current as Record<string, unknown> | undefined);
    const target = m.ensureMergeableMap("place").ensureMergeableMap(layout);
    for (const [k, v] of Object.entries(clean)) {
      if (v === null) target.delete(k);
      else target.set(k, v as never);
    }
  }

  private widgetMap(id: string): LoroMap | null {
    const m = this.loro.getMap("widgets").get(id);
    return m instanceof LoroMap ? m : null;
  }

  private requireWidget(id: string): LoroMap {
    const m = this.widgetMap(id);
    if (!m) throw new Error(`No widget with id ${id}`);
    return m;
  }
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function defaultPlace(layout: OrderedLayout, type: WidgetType): Record<string, unknown> {
  return layout === "page" ? { width: "text" } : layout === "grid" ? { ...GRID_SIZE[type] } : { slot: "panel" };
}

/** Round and clamp canvas numbers. Throws on a value that is not a finite number. */
function cleanCanvas(p: Partial<CanvasPlace>): Partial<CanvasPlace> {
  const L = CANVAS_LIMITS;
  const out: Partial<CanvasPlace> = {};
  for (const k of CANVAS_FIELDS) {
    if (p[k] === undefined) continue;
    const v = finite(p[k]);
    if (v === undefined) throw new Error(`Canvas ${k} must be a finite number.`);
    const r = Math.round(v);
    out[k] = k === "w" ? clamp(r, L.minW, L.maxSize) : k === "h" ? clamp(r, L.minH, L.maxSize) : clamp(r, -L.maxPos, L.maxPos);
  }
  return out;
}

/**
 * Check a page, grid or map patch against the current place. Returns the
 * fields to write (`null` = delete). Throws when the result is not valid.
 */
function checkPlace(layout: OrderedLayout, patch: Record<string, unknown>, current: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => patch[k] !== undefined;
  if (has("order")) {
    if (!isOrderKey(patch.order)) throw new Error(`Not a valid order key: ${String(patch.order)}`);
    out.order = patch.order;
  } else if (current?.order === undefined) {
    throw new Error(`The widget has no ${layout} place yet, so it needs an order key.`);
  }
  if (layout === "page" && has("width")) {
    if (!(PAGE_WIDTHS as readonly unknown[]).includes(patch.width)) throw new Error(`Page width must be one of: ${PAGE_WIDTHS.join(", ")}.`);
    out.width = patch.width;
  }
  if (layout === "grid") {
    for (const [k, max] of [["span", GRID_LIMITS.span], ["rows", GRID_LIMITS.rows]] as const) {
      if (!has(k)) continue;
      const v = finite(patch[k]);
      if (v === undefined) throw new Error(`Grid ${k} must be a number.`);
      out[k] = clamp(Math.round(v), 1, max);
    }
  }
  if (layout === "map") {
    if (has("slot")) {
      if (!(MAP_SLOTS as readonly unknown[]).includes(patch.slot)) throw new Error(`Map slot must be one of: ${MAP_SLOTS.join(", ")}.`);
      out.slot = patch.slot;
    }
    if (has("corner")) {
      if (!(MAP_CORNERS as readonly unknown[]).includes(patch.corner)) throw new Error(`Map corner must be one of: ${MAP_CORNERS.join(", ")}.`);
      out.corner = patch.corner;
    }
    const slot = (out.slot ?? current?.slot ?? "panel") as MapSlot;
    let lngLat = current?.lngLat;
    if (patch.lngLat === null) lngLat = undefined;
    else if (has("lngLat")) {
      const ll = patch.lngLat;
      const lng = Array.isArray(ll) && ll.length === 2 ? finite(ll[0]) : undefined;
      const lat = Array.isArray(ll) && ll.length === 2 ? finite(ll[1]) : undefined;
      if (lng === undefined || lat === undefined) throw new Error("lngLat must be [longitude, latitude].");
      lngLat = [clamp(lng, -180, 180), clamp(lat, -90, 90)];
    }
    if (slot === "marker") {
      if (lngLat === undefined) throw new Error("A map marker needs lngLat: [longitude, latitude].");
      if (has("lngLat")) out.lngLat = lngLat;
    } else if (has("lngLat") || current?.lngLat !== undefined) {
      // Only a marker has a position.
      out.lngLat = null;
    }
  }
  return out;
}

/** Read the places of a widget. `place.canvas` wins over the schema 1 top-level fields. */
function readPlaces(w: Record<string, unknown>): Places {
  const p = (w.place !== null && typeof w.place === "object" ? w.place : {}) as Record<string, Record<string, unknown> | undefined>;
  const c = p.canvas ?? {};
  const pick = (k: keyof CanvasPlace, d: number) => finite(c[k]) ?? finite(w[k]) ?? d;
  const out: Places = { canvas: { x: pick("x", 0), y: pick("y", 0), w: pick("w", 200), h: pick("h", 120), z: pick("z", 0) } };
  const page = p.page;
  if (page && isOrderKey(page.order)) {
    out.page = { order: page.order, width: (PAGE_WIDTHS as readonly unknown[]).includes(page.width) ? (page.width as PageWidth) : "text" };
  }
  const grid = p.grid;
  if (grid && isOrderKey(grid.order)) {
    const n = (v: unknown, max: number, d: number) => clamp(Math.round(finite(v) ?? d), 1, max);
    out.grid = { order: grid.order, span: n(grid.span, 12, GRID_DEFAULT.span), rows: n(grid.rows, 6, GRID_DEFAULT.rows) };
  }
  const map = p.map;
  if (map && isOrderKey(map.order)) {
    const slot = (MAP_SLOTS as readonly unknown[]).includes(map.slot) ? (map.slot as MapSlot) : "panel";
    out.map = { slot, order: map.order };
    if ((MAP_CORNERS as readonly unknown[]).includes(map.corner)) out.map.corner = map.corner as MapCorner;
    const ll = map.lngLat;
    if (slot === "marker" && Array.isArray(ll) && finite(ll[0]) !== undefined && finite(ll[1]) !== undefined) {
      out.map.lngLat = [ll[0] as number, ll[1] as number];
    }
  }
  return out;
}

/** Canvas reading order: top to bottom, then left to right, then id. */
function compareCanvas(a: Widget, b: Widget): number {
  return a.y - b.y || a.x - b.x || compareKeys(a.id, b.id);
}

function toWidget(id: string, w: Record<string, unknown>): Widget {
  const place = readPlaces(w);
  return {
    id,
    // Unknown types (from newer peers) show as notes, as schema 1 peers do.
    type: isWidgetType(w.type) ? w.type : "note",
    ...place.canvas,
    title: String(w.title ?? ""),
    content: String(w.content ?? ""),
    allow: Array.isArray(w.allow) ? w.allow.map(String) : [],
    createdBy: String(w.createdBy ?? ""),
    linked: w.linked === true,
    place,
  };
}

function parseMessage(message: string | undefined): Omit<Change, "at" | "peer"> {
  try {
    const m = JSON.parse(message ?? "");
    return { author: String(m.a ?? ""), action: String(m.k ?? ""), values: m.v ?? {} };
  } catch {
    return { author: "", action: message ?? "", values: {} };
  }
}

/** The map content after a patch, before checks; only used to find the basemap. */
function patchedMap(current: string, patch: Record<string, unknown>): unknown {
  try {
    return mergePatch(JSON.parse(current), patch);
  } catch {
    return patch;
  }
}
