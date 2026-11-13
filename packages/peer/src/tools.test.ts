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

  it("refuses the map layout for now", async () => {
    await expect(call("new_dashboard", { title: "M", layout: "map" })).rejects.toThrow(/map layout/);
  });
});
