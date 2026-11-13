import { describe, expect, it } from "vitest";
import { CanvasDoc } from "./doc";
import { summarise } from "./layout";
import { allowForMap, cleanDatetime, cleanMap, DEFAULT_BASEMAP, MAP_LIMITS } from "./map";
import { cleanContent, readTyped } from "./typed";

const OFM = DEFAULT_BASEMAP.origin;
const point = (lng: number, lat: number, props: Record<string, unknown> = {}) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lng, lat] } });
const sites = { id: "sites", type: "geojson", data: { type: "FeatureCollection", features: [point(13.4, 52.5, { name: "A" })] }, style: { color: "#d33", radius: 6 } };
const radar = { id: "radar", type: "raster", tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"], opacity: 0.6 };

describe("map content", () => {
  it("accepts a view, the default basemap and layers, with defaults", () => {
    const m = cleanMap({ view: { center: [13.4, 52.5], zoom: 9 }, layers: [sites] }, [OFM]);
    expect(m.basemap).toBe("default");
    expect(m.layers[0]).toMatchObject({ id: "sites", type: "geojson" });
    expect(cleanMap({}, [OFM]).view).toEqual({ center: [0, 20], zoom: 1 });
    expect(cleanMap({ view: { bbox: [5, 45, 10, 48] }, basemap: "none" }, []).view.bbox).toEqual([5, 45, 10, 48]);
  });

  it("rejects every URL whose origin is not in allow", () => {
    expect(() => cleanMap({ basemap: "default" }, [])).toThrow(/tiles\.openfreemap\.org.*not in this widget's allow list/);
    expect(() => cleanMap({ basemap: "none", layers: [radar] }, [])).toThrow(/https:\/\/tiles\.example\.com, which is not in this widget's allow list/);
    expect(() => cleanMap({ basemap: "none", layers: [radar] }, ["https://tiles.example.com/"])).not.toThrow();
    expect(() => cleanMap({ basemap: "https://styles.example.org/s.json" }, [])).toThrow(/styles\.example\.org/);
    expect(() => cleanMap({ basemap: "https://styles.example.org/s.json" }, ["https://styles.example.org"])).not.toThrow();
    // Only https, no credentials, known placeholders only.
    expect(() => cleanMap({ basemap: "none", layers: [{ ...radar, tiles: ["http://tiles.example.com/{z}/{x}/{y}.png"] }] }, ["https://tiles.example.com"])).toThrow(/https/);
    expect(() => cleanMap({ basemap: "none", layers: [{ ...radar, tiles: ["https://u:p@tiles.example.com/{z}/{x}/{y}.png"] }] }, ["https://tiles.example.com"])).toThrow(/password/);
    expect(() => cleanMap({ basemap: "none", layers: [{ ...radar, tiles: ["https://tiles.example.com/{token}/{z}.png"] }] }, ["https://tiles.example.com"])).toThrow(/placeholder \{token\}/);
    // A look-alike host is a different origin.
    expect(() => cleanMap({ basemap: "none", layers: [{ ...radar, tiles: ["https://tiles.example.com.evil.net/{z}/{x}/{y}.png"] }] }, ["https://tiles.example.com"])).toThrow(/evil\.net/);
  });

  it("limits inline GeoJSON", () => {
    const many = Array.from({ length: MAP_LIMITS.features + 1 }, (_, i) => point(0, (i % 80) - 40));
    expect(() => cleanMap({ basemap: "none", layers: [{ id: "a", type: "geojson", data: { type: "FeatureCollection", features: many } }] }, [])).toThrow(/too large|more than 5000 features/);
    const huge = { id: "a", type: "geojson", data: { type: "Feature", properties: { s: "x".repeat(MAP_LIMITS.content) }, geometry: null } };
    expect(() => cleanMap({ basemap: "none", layers: [huge] }, [])).toThrow(/too large/);
    expect(() => cleanMap({ basemap: "none", layers: [{ id: "a", type: "geojson", data: { type: "Point", coordinates: ["x", 1] } }] }, [])).toThrow(/position/);
    expect(() => cleanMap({ basemap: "none", layers: [{ id: "a", type: "geojson", data: { type: "Blob" } }] }, [])).toThrow(/geometry needs a type/);
  });

  it("checks layer ids, styles and the view", () => {
    expect(() => cleanMap({ basemap: "none", layers: [sites, sites] }, [])).toThrow(/unique/);
    expect(() => cleanMap({ basemap: "none", layers: [{ ...sites, style: { color: "url(x)" } }] }, [])).toThrow(/colour/);
    expect(() => cleanMap({ basemap: "none", layers: [{ ...sites, style: { "circle-color": "red" } }] }, [])).toThrow(/unknown key/);
    expect(() => cleanMap({ basemap: "none", view: { center: [200, 0], zoom: 1 } }, [])).toThrow(/longitude/);
    expect(() => cleanMap({ basemap: "none", view: { bbox: [10, 0, 5, 1] } }, [])).toThrow(/west/);
    expect(() => cleanMap({ basemap: "none", view: { zoom: 3 } }, [])).toThrow(/center/);
    // Attribution is text.
    const r = cleanMap({ basemap: "none", layers: [{ ...radar, attribution: "<b>NASA</b>" }] }, ["https://tiles.example.com"]);
    expect((r.layers[0] as { attribution: string }).attribution).toBe("bNASA/b");
  });

  it("adds the default basemap origin to allow when needed", () => {
    expect(allowForMap('{"view":{"center":[0,0],"zoom":1}}', [])).toEqual([OFM]);
    expect(allowForMap({ basemap: "none" }, ["https://a.example"])).toEqual(["https://a.example"]);
    expect(allowForMap({}, [`${OFM}/`])).toEqual([`${OFM}/`]);
  });

  it("checks datetimes", () => {
    expect(cleanDatetime("2026-05-01")).toBe("2026-05-01");
    expect(cleanDatetime("2026-05-01T12:00:00Z/..")).toBe("2026-05-01T12:00:00Z/..");
    expect(() => cleanDatetime("May 2026")).toThrow(/ISO 8601/);
    expect(() => cleanDatetime("../..")).toThrow();
    expect(() => cleanDatetime("2026-06-01/2026-05-01")).toThrow(/after the end/);
  });
});

describe("map widgets in the document", () => {
  it("creates a map with the basemap origin in allow, and refuses origins that are not allowed", () => {
    const d = CanvasDoc.create("M", "me", undefined, "map");
    const id = d.createWidget({ type: "map", content: JSON.stringify({ layers: [sites] }) }, "me");
    expect(d.widget(id)!.allow).toEqual([OFM]);
    expect(summarise(d.widget(id)!)).toMatch(/^map, 1 layer \(geojson sites 1 feature\), centre 0,20 zoom 1$/);
    expect(() => d.createWidget({ type: "map", content: JSON.stringify({ basemap: "none", layers: [radar] }) }, "me")).toThrow(/allow list/);
    // Removing the basemap origin from allow while the map uses it is refused.
    expect(() => d.updateWidget(id, { allow: [] }, "me")).toThrow(/default basemap/);
    d.updateWidget(id, { content: JSON.stringify({ basemap: "none" }), allow: [] }, "me");
    expect(d.widget(id)!.allow).toEqual([]);
  });

  it("patches a map: view, and layers by id", () => {
    const d = CanvasDoc.create("M", "me", undefined, "map");
    const id = d.createWidget({ type: "map", content: JSON.stringify({ basemap: "none", layers: [sites] }), allow: ["https://tiles.example.com"] }, "me");
    d.patchContent(id, { view: { center: [2, 48], zoom: 5 } }, "me");
    d.patchContent(id, { layers: { radar } }, "me");
    d.patchContent(id, { layers: { sites: { style: { color: "teal" } } } }, "me");
    let m = readTyped("map", d.widget(id)!.content, d.widget(id)!.allow);
    if ("error" in m) throw new Error(m.error);
    expect(m.data.view).toEqual({ center: [2, 48], zoom: 5 });
    expect(m.data.layers.map((l) => l.id)).toEqual(["sites", "radar"]);
    expect(m.data.layers[0]).toMatchObject({ style: { color: "teal", radius: 6 } });
    d.patchContent(id, { layers: { sites: null } }, "me");
    m = readTyped("map", d.widget(id)!.content, d.widget(id)!.allow);
    expect("data" in m && m.data.layers.map((l) => l.id)).toEqual(["radar"]);
    // A layer from an origin that is not allowed: nothing changes.
    expect(() => d.patchContent(id, { layers: { x: { ...radar, id: "x", tiles: ["https://other.example/{z}/{x}/{y}.png"] } } }, "me")).toThrow(/other\.example/);
    // Switching to the default basemap adds its origin.
    d.patchContent(id, { basemap: "default" }, "me");
    expect(d.widget(id)!.allow).toContain(OFM);
  });

  it("reads map content against the widget's allow list", () => {
    const content = JSON.stringify({ basemap: "none", layers: [radar] });
    expect(() => cleanContent("map", content, [])).toThrow(/allow list/);
    expect(readTyped("map", content, ["https://tiles.example.com"])).toHaveProperty("data");
  });

  it("keeps a linked flag per widget", () => {
    const d = CanvasDoc.create("M", "me");
    const a = d.createWidget({ type: "note", linked: true }, "me");
    const b = d.createWidget({ type: "note" }, "me");
    expect(d.widget(a)!.linked).toBe(true);
    expect(d.widget(b)!.linked).toBe(false);
    d.updateWidget(b, { linked: true }, "me");
    expect(d.widget(b)!.linked).toBe(true);
    expect(() => d.updateWidget(b, { linked: "yes" as never }, "me")).toThrow(/linked/);
  });
});

describe("map context", () => {
  it("sets and clears bbox and datetime, one commit each call", () => {
    const d = CanvasDoc.create("M", "me", undefined, "map");
    const n = () => d.changesSince().length;
    const start = n();
    d.setContext({ bbox: [5, 45, 10, 48], datetime: "2026-05-01" }, "Ann");
    expect(d.context()).toEqual({ bbox: [5, 45, 10, 48], datetime: "2026-05-01" });
    expect(n()).toBe(start + 1);
    expect(d.changesSince().at(-1)).toMatchObject({ author: "Ann", action: "context" });
    // The same values again: no commit.
    d.setContext({ bbox: [5, 45, 10, 48] }, "Ann");
    expect(n()).toBe(start + 1);
    d.setContext({ datetime: null }, "Ann");
    expect(d.context()).toEqual({ bbox: [5, 45, 10, 48] });
    expect(n()).toBe(start + 2);
    expect(() => d.setContext({ bbox: [10, 45, 5, 48] }, "Ann")).toThrow(/west/);
    expect(() => d.setContext({ datetime: "soon" }, "Ann")).toThrow(/ISO 8601/);
    expect(n()).toBe(start + 2);
  });

  it("merges context changes from two peers", () => {
    const a = CanvasDoc.create("M", "Ann", undefined, "map");
    const b = CanvasDoc.fromSnapshot(a.snapshot());
    a.setContext({ bbox: [0, 0, 1, 1] }, "Ann");
    b.setContext({ datetime: "2026-01-01" }, "Bob");
    a.applyRemote(b.updatesSince(new Uint8Array()));
    b.applyRemote(a.updatesSince(new Uint8Array()));
    expect(a.context()).toEqual({ bbox: [0, 0, 1, 1], datetime: "2026-01-01" });
    expect(b.context()).toEqual(a.context());
  });
});

describe("map slots", () => {
  it("needs lngLat for a marker, drops it for other slots, and keeps a corner", () => {
    const d = CanvasDoc.create("M", "me", undefined, "map");
    const id = d.createWidget({ type: "note" }, "me");
    expect(d.widget(id)!.place.map).toMatchObject({ slot: "panel" });
    expect(() => d.setPlace(id, "map", { slot: "marker" }, "me")).toThrow(/needs lngLat/);
    d.setPlace(id, "map", { slot: "marker", lngLat: [13.4, 52.5] }, "me");
    expect(d.widget(id)!.place.map).toMatchObject({ slot: "marker", lngLat: [13.4, 52.5] });
    d.setPlace(id, "map", { slot: "overlay", corner: "bottom-left" }, "me");
    expect(d.widget(id)!.place.map).toEqual({ slot: "overlay", order: expect.any(String), corner: "bottom-left" });
    expect(() => d.setPlace(id, "map", { corner: "middle" as never }, "me")).toThrow(/corner/);
    const m = d.createWidget({ type: "note", place: { map: { slot: "marker", lngLat: [1, 2] } } }, "me");
    expect(d.widget(m)!.place.map!.lngLat).toEqual([1, 2]);
  });

  it("uses the first map in order as the background map", () => {
    const d = CanvasDoc.create("M", "me", undefined, "map");
    expect(d.backgroundMap()).toBeNull();
    d.createWidget({ type: "note" }, "me");
    const a = d.createWidget({ type: "map", content: "{}" }, "me");
    const b = d.createWidget({ type: "map", content: "{}" }, "me");
    expect(d.backgroundMap()!.id).toBe(a);
    d.moveInOrder(b, "map", "start", "me");
    expect(d.backgroundMap()!.id).toBe(b);
  });
});
