import { LoroDoc, LoroMap } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { CanvasDoc } from "./doc";
import { isOrderKey, keyBetween } from "./order";

function sync(a: CanvasDoc, b: CanvasDoc) {
  b.applyRemote(a.updatesSince(b.versionBytes()));
  a.applyRemote(b.updatesSince(a.versionBytes()));
}

function fork(a: CanvasDoc): CanvasDoc {
  return CanvasDoc.fromSnapshot(a.snapshot());
}

const ids = (d: CanvasDoc, layout?: Parameters<CanvasDoc["readingOrder"]>[0]) => d.readingOrder(layout).map((w) => w.id);

/** A schema 1 document, as the first version wrote it: canvas fields at the widget's top level. */
function v1Doc(widgets: { id: string; x: number; y: number }[]): CanvasDoc {
  const loro = new LoroDoc();
  const meta = loro.getMap("meta");
  meta.set("id", "old");
  meta.set("title", "Old");
  meta.set("schemaVersion", 1);
  for (const w of widgets) {
    const m = loro.getMap("widgets").setContainer(w.id, new LoroMap());
    for (const [k, v] of Object.entries({ type: "note", x: w.x, y: w.y, w: 280, h: 180, z: 1, title: w.id, content: "", allow: [], createdBy: "old" })) {
      m.set(k, v as never);
    }
    m.setContainer("state", new LoroMap());
  }
  loro.commit();
  return CanvasDoc.fromSnapshot(loro.export({ mode: "snapshot" }));
}

describe("order keys", () => {
  it("makes a key between two keys", () => {
    const k = keyBetween("a0", "a1");
    expect(isOrderKey(k)).toBe(true);
    expect("a0" < k && k < "a1").toBe(true);
    expect(isOrderKey("a00")).toBe(false);
    expect(isOrderKey("")).toBe(false);
    expect(isOrderKey("a0 ")).toBe(false);
    expect(() => keyBetween("a1", "a0")).toThrow();
  });

  it("puts new widgets at the end, and moves a widget before or after another", () => {
    const d = CanvasDoc.create("T", "me", "t", "page");
    const a = d.createWidget({ type: "note", title: "a" }, "me");
    const b = d.createWidget({ type: "note", title: "b" }, "me");
    const c = d.createWidget({ type: "note", title: "c" }, "me");
    expect(ids(d)).toEqual([a, b, c]);
    d.moveInOrder(c, "page", { after: a }, "me");
    expect(ids(d)).toEqual([a, c, b]);
    d.moveInOrder(a, "page", { before: b }, "me");
    expect(ids(d)).toEqual([c, a, b]);
    d.moveInOrder(b, "page", "start", "me");
    expect(ids(d)).toEqual([b, c, a]);
    d.moveInOrder(b, "page", "end", "me");
    expect(ids(d)).toEqual([c, a, b]);
    expect(() => d.moveInOrder(b, "page", { after: b }, "me")).toThrow();
  });

  it("merges concurrent inserts to the same order on both peers", () => {
    const a = CanvasDoc.create("T", "a", "t", "page");
    const w1 = a.createWidget({ type: "note" }, "a");
    const w2 = a.createWidget({ type: "note" }, "a");
    const b = fork(a);
    // Both peers insert between w1 and w2, and both add one at the end.
    const x = a.createWidget({ type: "note" }, "a");
    a.moveInOrder(x, "page", { after: w1 }, "a");
    const y = b.createWidget({ type: "note" }, "b");
    b.moveInOrder(y, "page", { after: w1 }, "b");
    const ea = a.createWidget({ type: "note" }, "a");
    const eb = b.createWidget({ type: "note" }, "b");
    sync(a, b);
    expect(ids(a)).toEqual(ids(b));
    // The same keys: the widget id decides.
    expect(a.widget(x)!.place.page!.order).toBe(a.widget(y)!.place.page!.order);
    const [first, second] = [x, y].sort();
    const [lastA, lastB] = [ea, eb].sort();
    expect(ids(a)).toEqual([w1, first, second, w2, lastA, lastB]);
  });

  it("can insert between two widgets with the same key", () => {
    const a = CanvasDoc.create("T", "a", "t", "page");
    const w1 = a.createWidget({ type: "note" }, "a");
    const b = fork(a);
    const x = a.createWidget({ type: "note" }, "a");
    const y = b.createWidget({ type: "note" }, "b");
    sync(a, b);
    const [first, second] = [x, y].sort();
    const z = a.createWidget({ type: "note" }, "a");
    a.moveInOrder(z, "page", { after: first }, "a");
    expect(ids(a)).toEqual([w1, first, z, second]);
    sync(a, b);
    expect(ids(b)).toEqual(ids(a));
  });
});

describe("places", () => {
  it("clamps numbers and refuses bad values", () => {
    const d = CanvasDoc.create("T", "me");
    const id = d.createWidget({ type: "note", w: 10, h: 99999, x: 1.6 }, "me");
    expect(d.widget(id)).toMatchObject({ x: 2, w: 120, h: 8000 });
    d.setPlace(id, "grid", { span: 20, rows: 0 }, "me");
    expect(d.widget(id)!.place.grid).toMatchObject({ span: 12, rows: 1 });
    expect(() => d.setPlace(id, "page", { width: "huge" as never }, "me")).toThrow(/width/);
    expect(() => d.setPlace(id, "page", { order: "nope!" }, "me")).toThrow(/order key/);
    expect(() => d.setPlace(id, "map", { slot: "marker" }, "me")).toThrow(/lngLat/);
    expect(() => d.moveWidgets([{ id, x: Number.NaN, y: 0 }], "me")).toThrow();
    d.setPlace(id, "map", { slot: "marker", lngLat: [200, -95] }, "me");
    expect(d.widget(id)!.place.map).toMatchObject({ slot: "marker", lngLat: [180, -90] });
    d.setPlace(id, "map", { slot: "panel" }, "me");
    expect(d.widget(id)!.place.map!.lngLat).toBeUndefined();
  });

  it("gives a new widget a place in every layout", () => {
    const d = CanvasDoc.create("T", "me");
    const id = d.createWidget({ type: "note" }, "me");
    const p = d.widget(id)!.place;
    expect(p.page).toMatchObject({ width: "text" });
    expect(p.grid).toMatchObject({ span: 4, rows: 2 });
    expect(p.map).toMatchObject({ slot: "panel" });
    expect(d.schemaVersion).toBe(2);
  });

  it("keeps all places when the layout changes", () => {
    const d = CanvasDoc.create("T", "me");
    const a = d.createWidget({ type: "note", x: 0, y: 0 }, "me");
    const b = d.createWidget({ type: "note", x: 500, y: 0 }, "me");
    d.setPlace(a, "grid", { span: 8 }, "me");
    d.setPlace(b, "page", { width: "wide" }, "me");
    d.moveInOrder(b, "page", "start", "me");
    const before = d.widgets().map((w) => w.place);
    for (const l of ["page", "grid", "map", "canvas"] as const) {
      d.setLayout(l, "me");
      expect(d.layout).toBe(l);
    }
    expect(d.widgets().map((w) => w.place)).toEqual(before);
    expect(ids(d, "page")).toEqual([b, a]);
    expect(() => d.setLayout("tiles" as never, "me")).toThrow();
  });
});

describe("reading order", () => {
  it("reads a canvas top to bottom, then left to right", () => {
    const d = CanvasDoc.create("T", "me");
    const c = d.createWidget({ type: "note", x: 0, y: 400 }, "me");
    const b = d.createWidget({ type: "note", x: 400, y: 0 }, "me");
    const a = d.createWidget({ type: "note", x: 0, y: 0 }, "me");
    expect(ids(d)).toEqual([a, b, c]);
    // Page order is the order of creation.
    expect(ids(d, "page")).toEqual([c, b, a]);
  });
});

describe("schema 1 documents", () => {
  it("reads the old canvas fields and has the canvas layout", () => {
    const d = v1Doc([{ id: "w1", x: 10, y: 20 }]);
    expect(d.layout).toBe("canvas");
    expect(d.schemaVersion).toBe(1);
    expect(d.widget("w1")).toMatchObject({ x: 10, y: 20, w: 280, h: 180, z: 1 });
    expect(d.widget("w1")!.place.page).toBeUndefined();
  });

  it("writes place.canvas and the old fields, and marks the document as schema 2", () => {
    const d = v1Doc([{ id: "w1", x: 10, y: 20 }]);
    d.moveWidgets([{ id: "w1", x: 50, y: 60 }], "me");
    expect(d.widget("w1")).toMatchObject({ x: 50, y: 60, w: 280 });
    const raw = d.loro.getMap("widgets").toJSON() as Record<string, Record<string, unknown>>;
    // A schema 1 peer reads these.
    expect(raw.w1).toMatchObject({ x: 50, y: 60, place: { canvas: { x: 50, y: 60 } } });
    expect(d.schemaVersion).toBe(2);
  });

  it("merges places that two peers add to an old widget at the same time", () => {
    const a = v1Doc([{ id: "w1", x: 0, y: 0 }, { id: "w2", x: 0, y: 300 }]);
    const b = fork(a);
    a.moveWidgets([{ id: "w1", x: 5, y: 5 }], "a");
    a.setPlace("w1", "grid", { order: "a0", span: 6 }, "a");
    b.setPlace("w1", "page", { order: "a0", width: "full" }, "b");
    b.moveWidgets([{ id: "w1", x: 9, y: 9, w: 300 }], "b");
    sync(a, b);
    for (const d of [a, b]) {
      const p = d.widget("w1")!.place;
      expect(p.grid).toMatchObject({ span: 6 });
      expect(p.page).toMatchObject({ width: "full" });
      expect(p.canvas.w).toBe(300);
    }
    expect(a.widget("w1")).toEqual(b.widget("w1"));
    expect(a.schemaVersion).toBe(2);
  });

  it("sorts old widgets without a place last, and places them on a layout change", () => {
    const d = v1Doc([{ id: "low", x: 0, y: 500 }, { id: "high", x: 0, y: 0 }]);
    const n = d.createWidget({ type: "note", x: 0, y: 900 }, "me");
    expect(ids(d, "page")).toEqual([n, "high", "low"]);
    d.setLayout("page", "me");
    expect(ids(d)).toEqual([n, "high", "low"]);
    expect(d.widget("low")!.place.page).toBeDefined();
    const z = d.createWidget({ type: "note" }, "me");
    expect(ids(d).at(-1)).toBe(z);
  });
});
