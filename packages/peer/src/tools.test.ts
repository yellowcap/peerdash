import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Channel, Transport } from "@peerdash/core";
import { AgentPeer } from "./peer";
import { Store } from "./store";
import { createServer } from "./tools";

// A network with no other peers.
function nowhere(): Transport {
  const ch = <T>(): Channel<T> => ({ send: () => {}, on: () => {} });
  return { hello: ch(), update: ch(), presence: ch(), onPeerJoin: () => {}, onPeerLeave: () => {}, leave: () => {} };
}

let peer: AgentPeer;
let client: Client;

beforeEach(async () => {
  peer = new AgentPeer({ name: "Agent", store: new Store(mkdtempSync(join(tmpdir(), "peerdash-test-"))), connect: async () => nowhere() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(peer).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

afterEach(() => peer.leaveAll());

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0].text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text);
}

const metric = (label: string) => ({ type: "metric", data: { value: 1, label } });

describe("agent tools on a grid", () => {
  it("makes a grid and places widgets with span and rows", async () => {
    await call("new_dashboard", { title: "KPIs", layout: "grid" });
    const a = await call("create_widget", { ...metric("A"), span: 3 });
    expect(a).toMatchObject({ position: 1, of: 1, span: 3, rows: 2 });
    const b = await call("create_widget", { ...metric("B"), placement: "start", span: 40, rows: 0 });
    expect(b).toMatchObject({ position: 1, span: 12, rows: 1 });
    const c = await call("create_widget", { type: "note", content: "x", placement: `after:${b.widget_id}` });
    expect(c).toMatchObject({ position: 2, after: b.widget_id, span: 4, rows: 2 });
    const out = await call("get_outline", {});
    expect(out.dashboard.layout).toBe("grid");
    expect(out.widgets.map((w: { id: string }) => w.id)).toEqual([b.widget_id, c.widget_id, a.widget_id]);
    expect(out.widgets[0]).toMatchObject({ span: 12, rows: 1 });
    expect(out.widgets[0].x).toBeUndefined();
  });

  it("refuses a heading in a grid, and lists hidden headings after a layout change", async () => {
    await call("new_dashboard", { title: "Report", layout: "page" });
    const h = await call("create_widget", { type: "heading", data: { text: "Sales", level: 1 } });
    await call("create_widget", { type: "note", content: "x" });
    const set = await call("set_layout", { layout: "grid" });
    expect(set.not_shown).toMatch(/1 widget/);
    const out = await call("get_outline", {});
    expect(out.widgets).toHaveLength(1);
    expect(out.not_shown.widgets[0].id).toBe(h.widget_id);
    await expect(call("create_widget", { type: "heading", data: { text: "More", level: 2 } })).rejects.toThrow(/no heading/);
  });

  it("moves and resizes with move_in_layout, and clamps", async () => {
    await call("new_dashboard", { title: "G", layout: "grid" });
    const a = await call("create_widget", metric("A"));
    const b = await call("create_widget", metric("B"));
    const r = await call("move_in_layout", { widget_id: b.widget_id, placement: "start", span: 0, rows: 7 });
    expect(r).toMatchObject({ position: 1, span: 1, rows: 6 });
    await expect(call("move_in_layout", { widget_id: a.widget_id, width: "wide" })).rejects.toThrow(/span and rows/);
    await expect(call("move_in_layout", { widget_id: a.widget_id })).rejects.toThrow(/Give a placement/);
    // The old name still works.
    const s = await call("move_in_page", { widget_id: a.widget_id, span: 8 });
    expect(s).toMatchObject({ position: 2, span: 8 });
  });

  it("keeps page moves, and refuses grid sizes on a page", async () => {
    await call("new_dashboard", { title: "P", layout: "page" });
    const a = await call("create_widget", { type: "note", content: "a" });
    const b = await call("create_widget", { type: "note", content: "b", width: "wide" });
    expect(b).toMatchObject({ position: 2, width: "wide" });
    const r = await call("move_in_layout", { widget_id: b.widget_id, placement: `before:${a.widget_id}` });
    expect(r).toMatchObject({ position: 1 });
    await expect(call("move_in_layout", { widget_id: a.widget_id, span: 4 })).rejects.toThrow(/On a page, use width/);
  });

});

const OFM = "https://tiles.openfreemap.org";
const sites = { id: "sites", type: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "A" }, geometry: { type: "Point", coordinates: [13.4, 52.5] } }] } };

describe("agent tools on a map", () => {
  it("makes a map dashboard with a background map, panel, overlay and markers", async () => {
    const made = await call("new_dashboard", { title: "Berlin", layout: "map" });
    expect(made.link).toMatch(/#\/join\//);
    const m = await call("create_widget", { type: "map", title: "Berlin", data: { view: { center: [13.4, 52.5], zoom: 10 }, layers: [sites] } });
    expect(m).toMatchObject({ position: 1, slot: "background" });
    const a = await call("create_widget", metric("Visitors"));
    expect(a).toMatchObject({ slot: "panel" });
    const b = await call("create_widget", { type: "note", content: "first", placement: "start" });
    // "start" is before the map, so b is first in order; the background is still the first map.
    expect(b).toMatchObject({ position: 1, slot: "panel" });
    const o = await call("create_widget", { ...metric("Total"), slot: "overlay", corner: "bottom-left" });
    expect(o).toMatchObject({ slot: "overlay", corner: "bottom-left" });
    const k = await call("create_widget", { type: "note", content: "Gate", placement: "at:13.377,52.516" });
    expect(k).toMatchObject({ slot: "marker", lngLat: [13.377, 52.516] });
    const out = await call("get_outline", {});
    expect(out.dashboard.layout).toBe("map");
    expect(out.context).toEqual({});
    const byId = Object.fromEntries(out.widgets.map((w: { id: string }) => [w.id, w]));
    expect(byId[m.widget_id]).toMatchObject({ slot: "background" });
    expect(byId[k.widget_id]).toMatchObject({ slot: "marker", lngLat: [13.377, 52.516] });
    expect(byId[o.widget_id]).toMatchObject({ slot: "overlay", corner: "bottom-left" });
    expect(byId[m.widget_id].summary).toMatch(/^map, 1 layer/);
    const full = await call("get_widget", { widget_id: m.widget_id });
    expect(full.widget.allow).toEqual([OFM]);
    expect(full.data.layers[0].id).toBe("sites");
  });

  it("refuses bad map placements", async () => {
    await call("new_dashboard", { title: "M", layout: "map" });
    await expect(call("create_widget", { type: "note", content: "x", slot: "marker" })).rejects.toThrow(/needs a place/);
    await expect(call("create_widget", { type: "note", content: "x", placement: "at:13.4" })).rejects.toThrow(/longitude and a latitude/);
    await expect(call("create_widget", { type: "note", content: "x", placement: "at:1,2", slot: "panel" })).rejects.toThrow(/as a marker/);
    await expect(call("create_widget", { type: "note", content: "x", corner: "top-left" })).rejects.toThrow(/corner is for an overlay/);
    const g = await call("new_dashboard", { title: "G", layout: "grid" });
    await expect(call("create_widget", { type: "note", content: "x", slot: "overlay", dashboard_id: g.dashboard_id })).rejects.toThrow(/map layout/);
  });

  it("moves widgets between slots, and to a new place", async () => {
    await call("new_dashboard", { title: "M", layout: "map" });
    const n = await call("create_widget", { type: "note", content: "x" });
    const r = await call("move_in_layout", { widget_id: n.widget_id, placement: "at:2.35,48.86" });
    expect(r).toMatchObject({ slot: "marker", lngLat: [2.35, 48.86] });
    const o = await call("move_in_layout", { widget_id: n.widget_id, slot: "overlay", corner: "top-left" });
    expect(o).toMatchObject({ slot: "overlay", corner: "top-left" });
    await expect(call("move_in_layout", { widget_id: n.widget_id, slot: "marker" })).rejects.toThrow(/needs a place/);
    await expect(call("move_in_layout", { widget_id: n.widget_id, span: 3 })).rejects.toThrow(/On a map/);
    const back = await call("move_in_layout", { widget_id: n.widget_id, slot: "panel" });
    expect(back).toMatchObject({ slot: "panel" });
  });

  it("patches a map with small changes, and rejects origins that are not allowed", async () => {
    await call("new_dashboard", { title: "M", layout: "map" });
    const m = await call("create_widget", { type: "map", data: { basemap: "none", layers: [sites] } });
    await call("update_widget", { widget_id: m.widget_id, data: { view: { center: [2.35, 48.86], zoom: 11 } } });
    const radar = { type: "raster", tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"], opacity: 0.5 };
    await expect(call("update_widget", { widget_id: m.widget_id, data: { layers: { radar } } })).rejects.toThrow(/tiles\.example\.com.*allow list/);
    await call("update_widget", { widget_id: m.widget_id, data: { layers: { radar } }, allow: ["https://tiles.example.com"] });
    const w = await call("get_widget", { widget_id: m.widget_id });
    expect(w.widget.allow).toEqual(["https://tiles.example.com"]);
    expect(w.data.view).toEqual({ center: [2.35, 48.86], zoom: 11 });
    expect(w.data.layers.map((l: { id: string }) => l.id)).toEqual(["sites", "radar"]);
    await call("update_widget", { widget_id: m.widget_id, data: { layers: { sites: null } } });
    expect((await call("get_widget", { widget_id: m.widget_id })).data.layers).toHaveLength(1);
    await expect(call("create_widget", { type: "map", data: { basemap: "none", layers: [{ id: "x", ...radar }] } })).rejects.toThrow(/allow list/);
  });

  it("sets the context and links widgets", async () => {
    await call("new_dashboard", { title: "M", layout: "map" });
    const h = await call("create_widget", { type: "html", content: "<p>x</p>", linked: true });
    const r = await call("set_context", { bbox: [5.9, 45.8, 10.5, 47.8], datetime: "2026-05-01" });
    expect(r.context).toEqual({ bbox: [5.9, 45.8, 10.5, 47.8], datetime: "2026-05-01" });
    await call("set_context", { datetime: null });
    const out = await call("get_outline", {});
    expect(out.context).toEqual({ bbox: [5.9, 45.8, 10.5, 47.8] });
    expect(out.widgets[0]).toMatchObject({ id: h.widget_id, linked: true });
    await expect(call("set_context", { bbox: [10, 45, 5, 47] })).rejects.toThrow(/west/);
    await expect(call("set_context", {})).rejects.toThrow(/Give bbox/);
    await call("update_widget", { widget_id: h.widget_id, linked: false });
    expect((await call("get_outline", {})).widgets[0].linked).toBeUndefined();
  });

  it("changes a page to a map and says when a map is missing", async () => {
    await call("new_dashboard", { title: "P", layout: "page" });
    await call("create_widget", { type: "note", content: "x" });
    const r = await call("set_layout", { layout: "map" });
    expect(r.no_map).toMatch(/no map widget/);
    expect((await call("get_outline", {})).widgets[0]).toMatchObject({ slot: "panel" });
  });
});
