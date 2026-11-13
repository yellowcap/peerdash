import { describe, expect, it } from "vitest";
import { CanvasDoc, fitsLayout, GRID_SIZE } from "./doc";
import { orderTarget } from "./layout";

const ids = (d: CanvasDoc) => d.widgetsIn("grid").map((w) => w.id);

function grid(n: number) {
  const d = CanvasDoc.create("G", "me", undefined, "grid");
  const w = Array.from({ length: n }, (_, i) => d.createWidget({ type: "metric", content: JSON.stringify({ value: i, label: `M${i}` }) }, "me"));
  return { d, w };
}

describe("grid placement", () => {
  it("gives new widgets a grid size by type", () => {
    const d = CanvasDoc.create("G", "me", undefined, "grid");
    const m = d.createWidget({ type: "metric", content: '{"value":1,"label":"A"}' }, "me");
    const n = d.createWidget({ type: "note" }, "me");
    expect(d.widget(m)!.place.grid).toMatchObject(GRID_SIZE.metric);
    expect(d.widget(n)!.place.grid).toMatchObject({ span: 4, rows: 2 });
    // A given field wins; an undefined field keeps the default.
    const t = d.createWidget({ type: "html", place: { grid: { span: 8, rows: undefined } } }, "me");
    expect(d.widget(t)!.place.grid).toMatchObject({ span: 8, rows: GRID_SIZE.html.rows });
  });

  it("clamps and rounds span and rows, and refuses values that are not numbers", () => {
    const { d, w } = grid(1);
    const a = d.createWidget({ type: "note", place: { grid: { span: 99, rows: -3 } } }, "me");
    expect(d.widget(a)!.place.grid).toMatchObject({ span: 12, rows: 1 });
    d.setPlace(w[0], "grid", { span: 2.6, rows: 9 }, "me");
    expect(d.widget(w[0])!.place.grid).toMatchObject({ span: 3, rows: 6 });
    expect(() => d.setPlace(w[0], "grid", { span: Number.NaN }, "me")).toThrow(/span/);
    expect(() => d.setPlace(w[0], "grid", { rows: "2" as never }, "me")).toThrow(/rows/);
    expect(d.widget(w[0])!.place.grid).toMatchObject({ span: 3, rows: 6 });
  });

  it("resizes in one commit and keeps the order", () => {
    const { d, w } = grid(3);
    const before = d.changesSince().length;
    d.setPlace(w[1], "grid", { span: 8, rows: 3 }, "me");
    expect(d.changesSince().length).toBe(before + 1);
    expect(ids(d)).toEqual(w);
  });

  it("reads start, end, after, before and auto", () => {
    const { d, w } = grid(4);
    expect(orderTarget(d, "grid", "start")).toBe("start");
    expect(orderTarget(d, "grid", `after:${w[1]}`)).toEqual({ after: w[1] });
    expect(orderTarget(d, "grid", undefined, { selectedIds: [w[2], w[0]] })).toEqual({ after: w[2] });
    expect(orderTarget(d, "grid", "auto", { visibleIds: [w[0], w[1]] })).toEqual({ after: w[1] });
    expect(orderTarget(d, "grid", "auto")).toBe("end");
    expect(() => orderTarget(d, "grid", "span:4")).toThrow(/Unknown grid placement/);
  });

  it("keeps the reading order through moves", () => {
    const { d, w } = grid(4);
    d.moveInOrder(w[3], "grid", "start", "me");
    expect(ids(d)).toEqual([w[3], w[0], w[1], w[2]]);
    d.moveInOrder(w[0], "grid", { after: w[2] }, "me");
    expect(ids(d)).toEqual([w[3], w[1], w[2], w[0]]);
    const n = d.createWidget({ type: "chart", content: '{"mark":"bar"}', at: { grid: { before: w[1] } } }, "me");
    expect(ids(d)).toEqual([w[3], n, w[1], w[2], w[0]]);
    // The page order does not change.
    expect(d.readingOrder("page").map((x) => x.id)).toEqual([...w, n]);
  });
});

describe("headings and the grid", () => {
  it("are not in the grid", () => {
    expect(fitsLayout("heading", "grid")).toBe(false);
    expect(fitsLayout("heading", "page")).toBe(true);
    expect(fitsLayout("metric", "grid")).toBe(true);
    const { d } = grid(1);
    expect(() => d.createWidget({ type: "heading", content: '{"text":"Sales","level":1}' }, "me")).toThrow(/grid layout has no heading/);
  });

  it("stay in the document when a page becomes a grid, and come back", () => {
    const d = CanvasDoc.create("P", "me", undefined, "page");
    const h = d.createWidget({ type: "heading", content: '{"text":"Sales","level":1}' }, "me");
    const n = d.createWidget({ type: "note", content: "x" }, "me");
    d.setLayout("grid", "me");
    expect(ids(d)).toEqual([n]);
    expect(d.readingOrder("grid").map((w) => w.id)).toEqual([h, n]);
    expect(() => d.moveInOrder(h, "grid", "start", "me")).toThrow(/no heading/);
    expect(() => d.setPlace(h, "grid", { span: 6 }, "me")).toThrow(/no heading/);
    expect(() => orderTarget(d, "grid", `after:${h}`)).toThrow(/does not show/);
    // Headings in the selection do not count for auto.
    expect(orderTarget(d, "grid", "auto", { selectedIds: [h] })).toBe("end");
    d.setLayout("page", "me");
    expect(d.widgetsIn().map((w) => w.id)).toEqual([h, n]);
    // A heading can be added on a page, and moved there.
    d.moveInOrder(h, "page", "end", "me");
    expect(d.widgetsIn().map((w) => w.id)).toEqual([n, h]);
  });
});
