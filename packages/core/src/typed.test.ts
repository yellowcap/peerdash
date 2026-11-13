import { LoroMap } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { CanvasDoc, type WidgetType } from "./doc";
import { summarise } from "./layout";
import { cleanContent, mergePatch, readTyped, STARTER_CONTENT, TYPED_LIMITS, TYPED_WIDGETS } from "./typed";
import { allowForMap } from "./map";

const bar = {
  mark: "bar",
  data: { values: [{ a: "x", b: 3 }, { a: "y", b: 5 }] },
  encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } },
};

function docWith(type: WidgetType, content: unknown) {
  const doc = CanvasDoc.create("T", "me");
  const id = doc.createWidget({ type, content: typeof content === "string" ? content : JSON.stringify(content) }, "me");
  return { doc, id };
}

describe("heading", () => {
  it("accepts text and a level, with level 2 by default", () => {
    expect(JSON.parse(cleanContent("heading", { text: " Sales " }))).toEqual({ text: "Sales", level: 2 });
    expect(JSON.parse(cleanContent("heading", '{"text":"Top","level":1}'))).toEqual({ text: "Top", level: 1 });
  });
  it("rejects empty text, a bad level, and text that is too long", () => {
    expect(() => cleanContent("heading", { text: "" })).toThrow(/empty/);
    expect(() => cleanContent("heading", { text: "A", level: 4 })).toThrow(/level/);
    expect(() => cleanContent("heading", { text: "x".repeat(TYPED_LIMITS.headingText + 1) })).toThrow(/at most/);
  });
});

describe("metric", () => {
  it("accepts a value and label, and the optional fields", () => {
    const m = { value: 1250, label: "Orders", unit: "€", delta: -3.2, better: "down", trend: [1, 2, 3] };
    expect(JSON.parse(cleanContent("metric", m))).toEqual(m);
    expect(JSON.parse(cleanContent("metric", { value: "$1.2M", label: "ARR", delta: "+4% vs Q1" }))).toMatchObject({ value: "$1.2M", delta: "+4% vs Q1" });
  });
  it("rejects a missing value or label, a bad trend, and a bad direction", () => {
    expect(() => cleanContent("metric", { label: "Orders" })).toThrow(/value is required/);
    expect(() => cleanContent("metric", { value: 1 })).toThrow(/label/);
    expect(() => cleanContent("metric", { value: 1, label: "x", trend: [1, "2"] })).toThrow(/only numbers/);
    expect(() => cleanContent("metric", { value: 1, label: "x", trend: Array(TYPED_LIMITS.trend + 1).fill(1) })).toThrow(/at most/);
    expect(() => cleanContent("metric", { value: 1, label: "x", better: "left" })).toThrow(/better/);
    expect(() => cleanContent("metric", { value: Infinity, label: "x" })).toThrow(/finite/);
  });
});

describe("table", () => {
  it("accepts array rows and object rows, and pads short rows", () => {
    const t = JSON.parse(cleanContent("table", { columns: ["Name", "Count"], rows: [["A", 3], { Name: "B", Count: 5 }, ["C"]] }));
    expect(t).toEqual({ columns: ["Name", "Count"], rows: [["A", 3], ["B", 5], ["C", null]] });
  });
  it("rejects missing columns, long rows, bad cells and too many rows", () => {
    expect(() => cleanContent("table", { rows: [] })).toThrow(/columns/);
    expect(() => cleanContent("table", { columns: ["a"], rows: [[1, 2]] })).toThrow(/2 cells/);
    expect(() => cleanContent("table", { columns: ["a"], rows: [[{ x: 1 }]] })).toThrow(/cell/);
    expect(() => cleanContent("table", { columns: ["a"], rows: Array(TYPED_LIMITS.tableRows + 1).fill([1]) })).toThrow(/at most/);
  });
});

describe("chart", () => {
  it("accepts a Vega-Lite spec with inline data and the Vega-Lite schema", () => {
    expect(JSON.parse(cleanContent("chart", bar))).toEqual(bar);
    expect(() => cleanContent("chart", { $schema: "https://vega.github.io/schema/vega-lite/v6.json", ...bar })).not.toThrow();
    expect(() => cleanContent("chart", { layer: [bar] })).not.toThrow();
  });
  it("rejects remote data", () => {
    expect(() => cleanContent("chart", { ...bar, data: { url: "https://example.com/data.csv" } })).toThrow(/inline data: "data\.url"/);
    expect(() => cleanContent("chart", { ...bar, data: { url: "data/cars.json" } })).toThrow(/not allowed/);
    expect(() => cleanContent("chart", { layer: [{ ...bar, data: { url: "x.csv" } }] })).toThrow(/layer\.0\.data\.url/);
  });
  it("rejects every other URL: images, links, strings and embed options", () => {
    expect(() => cleanContent("chart", { ...bar, mark: "image", encoding: { url: { field: "img" } } })).toThrow(/encoding\.url/);
    expect(() => cleanContent("chart", { ...bar, encoding: { ...bar.encoding, href: { field: "a" } } })).toThrow(/href/);
    expect(() => cleanContent("chart", { ...bar, data: { values: [{ a: "javascript:alert(1)" }] } })).toThrow(/looks like a URL/);
    expect(() => cleanContent("chart", { ...bar, data: { values: [{ a: "//evil.example/x.png" }] } })).toThrow(/looks like a URL/);
    expect(() => cleanContent("chart", { ...bar, usermeta: { embedOptions: { actions: true } } })).toThrow(/usermeta/);
    expect(() => cleanContent("chart", { $schema: "https://evil.example/schema.json", ...bar })).toThrow(/\$schema/);
  });
  it("allows ordinary text with a colon", () => {
    expect(() => cleanContent("chart", { ...bar, title: "Sales: 2026", data: { values: [{ a: "Note: high", b: 1 }] } })).not.toThrow();
  });
  it("rejects specs with no mark, and specs that are too large", () => {
    expect(() => cleanContent("chart", { data: bar.data })).toThrow(/mark/);
    const big = { ...bar, data: { values: Array(5000).fill({ a: "xxxxxxxxxx", b: 1 }) } };
    expect(() => cleanContent("chart", big)).toThrow(/too large/);
  });
});

describe("content in the document", () => {
  it("rejects content that is not JSON, or not valid, and writes nothing", () => {
    const doc = CanvasDoc.create("T", "me");
    expect(() => doc.createWidget({ type: "metric", content: "12" }, "me")).toThrow(/JSON object/);
    expect(() => doc.createWidget({ type: "table", content: "not json" }, "me")).toThrow(/must be JSON/);
    expect(() => doc.createWidget({ type: "chart", content: JSON.stringify({ ...bar, data: { url: "x" } }) }, "me")).toThrow();
    expect(doc.widgets()).toHaveLength(0);
  });
  it("rejects an unknown type", () => {
    const doc = CanvasDoc.create("T", "me");
    expect(() => doc.createWidget({ type: "image" as WidgetType }, "me")).toThrow(/Unknown widget type/);
  });
  it("stores compact JSON, and checks updates", () => {
    const { doc, id } = docWith("heading", '{ "text": "A" }');
    expect(doc.widget(id)!.content).toBe('{"text":"A","level":2}');
    expect(() => doc.updateWidget(id, { content: '{"text":""}' }, "me")).toThrow();
    expect(doc.widget(id)!.content).toBe('{"text":"A","level":2}');
    doc.updateWidget(id, { content: '{"text":"B","level":3}' }, "me");
    expect(doc.widget(id)!.content).toBe('{"text":"B","level":3}');
  });
  it("patches a metric value and keeps the other fields", () => {
    const { doc, id } = docWith("metric", { value: 1, label: "Orders", unit: "€", trend: [1, 2] });
    doc.patchContent(id, { value: 3, trend: [1, 2, 3], unit: null }, "me");
    expect(JSON.parse(doc.widget(id)!.content)).toEqual({ value: 3, label: "Orders", trend: [1, 2, 3] });
    expect(() => doc.patchContent(id, { label: "" }, "me")).toThrow();
    expect(JSON.parse(doc.widget(id)!.content).label).toBe("Orders");
  });
  it("patches nested chart data", () => {
    const { doc, id } = docWith("chart", bar);
    doc.patchContent(id, { data: { values: [{ a: "z", b: 9 }] } }, "me");
    const c = JSON.parse(doc.widget(id)!.content);
    expect(c.data.values).toEqual([{ a: "z", b: 9 }]);
    expect(c.encoding).toEqual(bar.encoding);
    expect(() => doc.patchContent(id, { data: { url: "https://x.example/a.csv" } }, "me")).toThrow(/data\.url/);
  });
  it("does not patch a note", () => {
    const { doc, id } = docWith("note", "hi");
    expect(() => doc.patchContent(id, { text: "x" }, "me")).toThrow(/Only heading/);
  });
  it("has starter content that is valid for every type", () => {
    for (const t of TYPED_WIDGETS) expect(() => cleanContent(t, STARTER_CONTENT[t], allowForMap(STARTER_CONTENT[t], []))).not.toThrow();
  });
  it("reads content written without checks (old peers) without throwing", () => {
    const { doc, id } = docWith("metric", { value: 1, label: "x" });
    // An old peer shows the metric as a note, and its edits skip the checks.
    (doc.loro.getMap("widgets").get(id) as LoroMap).set("content", "# edited as a note");
    doc.loro.commit();
    const w = doc.widget(id)!;
    expect(w.type).toBe("metric");
    expect(readTyped("metric", w.content)).toHaveProperty("error");
    expect(summarise(w)).toMatch(/^\(not valid: /);
  });
  it("reads unknown types from newer peers as notes", () => {
    const { doc, id } = docWith("note", "hi");
    (doc.loro.getMap("widgets").get(id) as LoroMap).set("type", "hologram");
    doc.loro.commit();
    expect(doc.widget(id)!.type).toBe("note");
  });
});

describe("summarise", () => {
  const line = (type: WidgetType, content: unknown) => {
    const { doc, id } = docWith(type, content);
    return summarise(doc.widget(id)!);
  };
  it("gives one short line per type", () => {
    expect(line("heading", { text: "Costs", level: 1 })).toBe("H1: Costs");
    expect(line("metric", { value: 1250, label: "Orders", unit: "€", delta: 3.2, trend: [1, 2, 3] })).toBe("Orders: 1250 € (+3.2), trend of 3");
    expect(line("metric", { value: "n/a", label: "Churn", delta: "-1 pt" })).toBe("Churn: n/a (-1 pt)");
    expect(line("chart", { ...bar, title: "By label" })).toBe("bar chart, 2 rows, By label");
    expect(line("chart", { layer: [bar], data: bar.data })).toBe("layered chart, 2 rows");
    expect(line("table", { columns: ["Name", "Count"], rows: [["A", 1]] })).toBe("table, 2 columns (Name, Count), 1 rows");
  });
});

describe("mergePatch", () => {
  it("follows RFC 7386", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({ a: 1, b: { d: 3, e: 4 }, f: [1] });
    expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });
});
