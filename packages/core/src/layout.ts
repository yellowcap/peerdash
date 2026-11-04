// Where to put a new widget. Used by the agent peer so that "put it next to the
// selected chart" or "in my view" land somewhere sensible without overlaps.

import type { Widget } from "./doc";
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

/** One line per widget, for agents and logs. */
export function summarise(w: Widget, max = 120): string {
  const text = w.type === "html" ? stripTags(w.content) : w.content;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
}
