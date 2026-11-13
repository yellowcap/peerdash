// Where to put a new widget. Used by the agent peer so that "put it next to the
// selected chart" or "in my view" land somewhere sensible without overlaps.

import { fitsLayout, type CanvasDoc, type OrderedLayout, type OrderTarget, type Widget } from "./doc";
import { isTypedWidget, summariseTyped } from "./typed";
import type { Viewport } from "./session";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GAP = 40;

export function bounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP / 2 && b.x < a.x + a.w + GAP / 2 && a.y < b.y + b.h + GAP / 2 && b.y < a.y + a.h + GAP / 2;
}

/**
 * First free spot for a `w`×`h` widget, scanning right of `anchor` then rows
 * below it. Without an anchor, the spot is right of everything on the canvas.
 */
export function freeSpot(widgets: Rect[], w: number, h: number, anchor?: Rect | null): { x: number; y: number } {
  const all = bounds(widgets);
  if (!anchor) {
    if (!all) return { x: 0, y: 0 };
    anchor = { x: all.x + all.w, y: all.y, w: 0, h: 0 };
    return { x: Math.round(anchor.x + GAP), y: Math.round(anchor.y) };
  }
  const step = GAP;
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 40; col++) {
      const cand = { x: anchor.x + anchor.w + GAP + col * step, y: anchor.y + row * step, w, h };
      if (!widgets.some((r) => overlaps(cand, r))) return { x: Math.round(cand.x), y: Math.round(cand.y) };
    }
  }
  return { x: Math.round(anchor.x + anchor.w + GAP), y: Math.round(anchor.y) };
}

/** A free spot inside the viewport if possible, else next to it. */
export function spotInView(widgets: Rect[], w: number, h: number, view: Viewport): { x: number; y: number } {
  const centre = { x: view.x + view.w / 2 - w / 2, y: view.y + view.h / 2 - h / 2, w, h };
  if (!widgets.some((r) => overlaps(centre, r))) return { x: Math.round(centre.x), y: Math.round(centre.y) };
  const inView = widgets.filter((r) => overlaps(r, view));
  return freeSpot(widgets, w, h, bounds(inView) ?? { ...centre, w: 0, h: 0 });
}

export const ORDER_PLACEMENTS = "start, end, after:<widget_id>, before:<widget_id>, auto";

/** What a person looks at on a page or a grid. */
export interface PageHere {
  selectedIds?: string[];
  visibleIds?: string[];
}

/**
 * The spot in a page or grid for a placement string:
 * - `start`, `end`;
 * - `after:<id>`, `before:<id>`;
 * - `auto` (default): after the selected widget (the last one, if there are
 *   more), else after the last widget in view, else at the end.
 * Throws on an unknown placement, an unknown widget id, or a widget that the
 * layout does not show (a heading in the grid).
 */
export function orderTarget(doc: CanvasDoc, layout: OrderedLayout, placement: string | undefined, here: PageHere = {}): OrderTarget {
  const p = (placement ?? "auto").trim();
  if (p === "start" || p === "end") return p;
  const m = p.match(/^(after|before):(.+)$/);
  if (m) {
    const ref = m[2].trim();
    const w = doc.widget(ref);
    if (!w) throw new Error(`No widget with id ${ref}`);
    if (!fitsLayout(w.type, layout)) throw new Error(`Widget ${ref} is a ${w.type}. The ${layout} layout does not show it, so it cannot be a reference.`);
    return m[1] === "after" ? { after: ref } : { before: ref };
  }
  if (p !== "auto") throw new Error(`Unknown ${layout} placement "${p}". Use one of: ${ORDER_PLACEMENTS}.`);
  const order = doc.widgetsIn(layout).map((w) => w.id);
  const lastOf = (ids: string[] | undefined) => {
    const set = new Set(ids ?? []);
    return order.filter((id) => set.has(id)).at(-1);
  };
  const ref = lastOf(here.selectedIds) ?? lastOf(here.visibleIds);
  return ref ? { after: ref } : "end";
}

/** `orderTarget` for the page layout. */
export function pageTarget(doc: CanvasDoc, placement: string | undefined, here: PageHere = {}): OrderTarget {
  return orderTarget(doc, "page", placement, here);
}

/** One line per widget, for agents and logs. */
export function summarise(w: Widget, max = 120): string {
  const text = isTypedWidget(w.type) ? summariseTyped(w.type, w.content, w.allow) : w.type === "html" ? stripTags(w.content) : w.content;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
}
