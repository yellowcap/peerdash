import { describe, expect, it } from "vitest";
import { CanvasDoc } from "./doc";
import { pageTarget } from "./layout";

const ids = (d: CanvasDoc) => d.readingOrder("page").map((w) => w.id);

function page(n: number) {
  const d = CanvasDoc.create("P", "me", undefined, "page");
  const w = Array.from({ length: n }, (_, i) => d.createWidget({ type: "note", content: String(i) }, "me"));
  return { d, w };
}

describe("page placement", () => {
  it("reads start, end, after and before", () => {
    const { d, w } = page(2);
    expect(pageTarget(d, "start")).toBe("start");
    expect(pageTarget(d, "end")).toBe("end");
    expect(pageTarget(d, `after:${w[0]}`)).toEqual({ after: w[0] });
    expect(pageTarget(d, `before:${w[1]}`)).toEqual({ before: w[1] });
    expect(() => pageTarget(d, "after:nope")).toThrow(/No widget/);
    expect(() => pageTarget(d, "right_of:x")).toThrow(/Unknown page placement/);
  });

  it("puts auto after the selected block, else after the last block in view, else at the end", () => {
    const { d, w } = page(4);
    // Two blocks selected: after the later one in reading order.
    expect(pageTarget(d, undefined, { selectedIds: [w[2], w[0]], visibleIds: [w[3]] })).toEqual({ after: w[2] });
    expect(pageTarget(d, "auto", { visibleIds: [w[1], w[0]] })).toEqual({ after: w[1] });
    // Ids that are not on the page are ignored.
    expect(pageTarget(d, "auto", { selectedIds: ["gone"], visibleIds: [] })).toBe("end");
    expect(pageTarget(d, "auto")).toBe("end");
  });

  it("creates a widget at a spot in one commit", () => {
    const { d, w } = page(3);
    const before = d.changesSince().length;
    const n = d.createWidget({ type: "html", at: { page: pageTarget(d, `after:${w[0]}`) }, place: { page: { width: "wide" } } }, "me");
    expect(d.changesSince().length).toBe(before + 1);
    expect(ids(d)).toEqual([w[0], n, w[1], w[2]]);
    expect(d.widget(n)!.place.page!.width).toBe("wide");
    const s = d.createWidget({ type: "note", at: { page: "start" } }, "me");
    const b = d.createWidget({ type: "note", at: { page: { before: w[2] } } }, "me");
    expect(ids(d)).toEqual([s, w[0], n, w[1], b, w[2]]);
    expect(() => d.createWidget({ type: "note", at: { page: { after: "nope" } } }, "me")).toThrow();
    expect(d.widgets().length).toBe(6);
  });

  it("creates after a widget that shares its key with a concurrent insert", () => {
    const a = CanvasDoc.create("P", "a", undefined, "page");
    const first = a.createWidget({ type: "note" }, "a");
    const b = CanvasDoc.fromSnapshot(a.snapshot());
    const x = a.createWidget({ type: "note" }, "a");
    const y = b.createWidget({ type: "note" }, "b");
    a.applyRemote(b.updatesSince(a.versionBytes()));
    const lo = ids(a)[1];
    const n = a.createWidget({ type: "note", at: { page: { after: lo } } }, "a");
    expect(ids(a)).toEqual([first, lo, n, lo === x ? y : x]);
  });
});
