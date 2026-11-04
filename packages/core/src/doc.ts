// One canvas = one Loro document.
//
// - `meta` (map): id, title, createdAt, schemaVersion
// - `widgets` (map): widgetId → map { type, x, y, w, h, z, title, content, allow, createdBy, state (map) }
// - `edges` (map): edgeId → map { from, to, label }
// - `comments` (map): commentId → map { widgetId, text, author, createdAt, resolved }
//
// Every mutation is a named method that commits exactly one Loro change. The
// commit message is `{"a": author, "k": action, "v": values}`, so the history
// says who did what, and survives merges. The UI and the agent peer never write
// to Loro directly.

import { LoroDoc, LoroMap, VersionVector } from "loro-crdt";

export const SCHEMA_VERSION = 1;

export type WidgetType = "note" | "html";

export interface Widget {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  title: string;
  /** Markdown for `note`, an HTML document or fragment for `html`. */
  content: string;
  /** Network origins an `html` widget may load from (empty = none). */
  allow: string[];
  createdBy: string;
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

export type WidgetInput = Partial<Omit<Widget, "id" | "createdBy">> & { type: WidgetType };
export type WidgetPatch = Partial<Pick<Widget, "x" | "y" | "w" | "h" | "z" | "title" | "content" | "allow">>;

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
};

const WIDGET_FIELDS = ["type", "x", "y", "w", "h", "z", "title", "content", "allow", "createdBy"] as const;

export function newId(): string {
  return crypto.randomUUID();
}

export class CanvasDoc {
  readonly loro: LoroDoc;

  constructor(loro: LoroDoc = new LoroDoc()) {
    this.loro = loro;
    // Commit timestamps make the change log readable.
    this.loro.setRecordTimestamp(true);
  }

  static create(title: string, author: string, id: string = newId()): CanvasDoc {
    const doc = new CanvasDoc();
    const meta = doc.loro.getMap("meta");
    meta.set("id", id);
    meta.set("title", title);
    meta.set("createdAt", Date.now());
    meta.set("schemaVersion", SCHEMA_VERSION);
    doc.commit(author, "create", { title });
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

  widgets(): Widget[] {
    const all = this.loro.getMap("widgets").toJSON() as Record<string, Record<string, unknown>>;
    return Object.entries(all)
      .map(([id, w]) => toWidget(id, w))
      .sort((a, b) => a.z - b.z);
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

  createWidget(input: WidgetInput, author: string): string {
    const id = newId();
    const size = DEFAULT_SIZE[input.type];
    const top = this.widgets().reduce((z, w) => Math.max(z, w.z), 0);
    const m = this.loro.getMap("widgets").setContainer(id, new LoroMap());
    const values: Omit<Widget, "id"> = {
      type: input.type,
      x: input.x ?? 0,
      y: input.y ?? 0,
      w: input.w ?? size.w,
      h: input.h ?? size.h,
      z: input.z ?? top + 1,
      title: input.title ?? "",
      content: input.content ?? "",
      allow: input.allow ?? [],
      createdBy: author,
    };
    for (const k of WIDGET_FIELDS) m.set(k, values[k]);
    m.setContainer("state", new LoroMap());
    this.commit(author, "add", { id, type: input.type, title: values.title });
    return id;
  }

  updateWidget(id: string, patch: WidgetPatch, author: string) {
    const m = this.requireWidget(id);
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return;
    for (const [k, v] of fields) m.set(k, v);
    this.commit(author, "edit", { id, fields: fields.map(([k]) => k) });
  }

  moveWidgets(moves: { id: string; x: number; y: number; w?: number; h?: number }[], author: string) {
    if (moves.length === 0) return;
    for (const mv of moves) {
      const m = this.requireWidget(mv.id);
      m.set("x", Math.round(mv.x));
      m.set("y", Math.round(mv.y));
      if (mv.w !== undefined) m.set("w", Math.round(mv.w));
      if (mv.h !== undefined) m.set("h", Math.round(mv.h));
    }
    this.commit(author, "move", { ids: moves.map((m) => m.id) });
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
    this.loro.commit({ message: JSON.stringify({ a: author, k: action, v: values }) });
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

function toWidget(id: string, w: Record<string, unknown>): Widget {
  return {
    id,
    type: w.type === "html" ? "html" : "note",
    x: Number(w.x ?? 0),
    y: Number(w.y ?? 0),
    w: Number(w.w ?? 200),
    h: Number(w.h ?? 120),
    z: Number(w.z ?? 0),
    title: String(w.title ?? ""),
    content: String(w.content ?? ""),
    allow: Array.isArray(w.allow) ? w.allow.map(String) : [],
    createdBy: String(w.createdBy ?? ""),
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
