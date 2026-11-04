import { describe, expect, it } from "vitest";
import { CanvasDoc } from "./doc";
import { emptyPresence, SyncSession, type Channel, type Transport } from "./session";

// In-memory network: every transport in a hub sees the others as peers.
class Hub {
  private nodes = new Map<string, Node>();

  connect(id: string): Transport {
    const node = new Node(id, this);
    for (const other of this.nodes.values()) {
      queueMicrotask(() => {
        other.join?.(id);
        node.join?.(other.id);
      });
    }
    this.nodes.set(id, node);
    return node.transport();
  }

  deliver(from: string, to: string | undefined, kind: string, data: unknown) {
    for (const n of this.nodes.values()) {
      if (n.id === from || (to && n.id !== to)) continue;
      queueMicrotask(() => n.handlers.get(kind)?.(structuredClone(data), from));
    }
  }

  remove(id: string) {
    this.nodes.delete(id);
    for (const n of this.nodes.values()) n.leaveHandler?.(id);
  }
}

class Node {
  handlers = new Map<string, (data: unknown, from: string) => void>();
  join?: (id: string) => void;
  leaveHandler?: (id: string) => void;
  constructor(
    readonly id: string,
    private hub: Hub,
  ) {}

  transport(): Transport {
    const ch = <T>(kind: string): Channel<T> => ({
      send: (data, to) => this.hub.deliver(this.id, to, kind, data),
      on: (h) => this.handlers.set(kind, h as (d: unknown, f: string) => void),
    });
    return {
      hello: ch("hello"),
      update: ch("update"),
      presence: ch("presence"),
      onPeerJoin: (h) => (this.join = h),
      onPeerLeave: (h) => (this.leaveHandler = h),
      leave: () => this.hub.remove(this.id),
    };
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("SyncSession", () => {
  it("brings a new peer up to date and syncs edits both ways", async () => {
    const hub = new Hub();
    const a = CanvasDoc.create("Sales", "Ann");
    a.createWidget({ type: "note", content: "hello" }, "Ann");
    const sa = new SyncSession(a, hub.connect("a"), emptyPresence("Ann", "human"));

    const b = new CanvasDoc();
    const sb = new SyncSession(b, hub.connect("b"), emptyPresence("Claude", "agent"));
    await tick();

    expect(b.id).toBe(a.id);
    expect(b.widgets().map((w) => w.content)).toEqual(["hello"]);

    const id = b.createWidget({ type: "html", content: "<p>chart</p>" }, "Claude");
    await tick();
    expect(a.widget(id)?.content).toBe("<p>chart</p>");
    expect(a.changesSince().at(-1)).toMatchObject({ author: "Claude", action: "add" });

    expect(sa.state.peers[0]).toMatchObject({ name: "Claude", kind: "agent", synced: true });
    sb.setPresence({ activity: "editing chart" });
    await tick();
    expect(sa.state.peers[0].activity).toBe("editing chart");
  });

  it("ignores a peer with a different canvas", async () => {
    const hub = new Hub();
    const a = CanvasDoc.create("A", "Ann");
    const b = CanvasDoc.create("B", "Bob");
    const sa = new SyncSession(a, hub.connect("a"), emptyPresence("Ann", "human"));
    new SyncSession(b, hub.connect("b"), emptyPresence("Bob", "human"));
    await tick();
    b.createWidget({ type: "note", content: "secret" }, "Bob");
    await tick();
    expect(a.widgets()).toEqual([]);
    expect(sa.state.error).toBe("otherCanvas");
  });
});

describe("CanvasDoc", () => {
  it("records changes since a version", () => {
    const d = CanvasDoc.create("T", "Ann");
    const v = d.version();
    const id = d.createWidget({ type: "note" }, "Ann");
    d.moveWidgets([{ id, x: 10, y: 20 }], "Claude");
    expect(d.changesSince(v).map((c) => `${c.author}:${c.action}`)).toEqual(["Ann:add", "Claude:move"]);
    expect(d.widget(id)).toMatchObject({ x: 10, y: 20, w: 280 });
  });

  it("removes edges with their widgets", () => {
    const d = CanvasDoc.create("T", "Ann");
    const a = d.createWidget({ type: "note" }, "Ann");
    const b = d.createWidget({ type: "note" }, "Ann");
    d.connect(a, b, "", "Ann");
    d.deleteWidgets([a], "Ann");
    expect(d.edges()).toEqual([]);
  });

  it("keeps comments per widget and drops them with the widget", () => {
    const d = CanvasDoc.create("T", "Ann");
    const a = d.createWidget({ type: "note" }, "Ann");
    const b = d.createWidget({ type: "note" }, "Ann");
    const c1 = d.addComment(a, "  Is this right?  ", "Ann");
    d.addComment(b, "Nice", "Bob");
    d.resolveComment(c1, true, "Claude");
    expect(d.comments(a)).toMatchObject([{ text: "Is this right?", author: "Ann", resolved: true }]);
    expect(d.changesSince().map((c) => c.action)).toContain("comment");
    expect(() => d.addComment(a, "   ", "Ann")).toThrow();
    d.deleteWidgets([a], "Ann");
    expect(d.comments().map((c) => c.text)).toEqual(["Nice"]);
  });

  it("keeps widget state", () => {
    const d = CanvasDoc.create("T", "Ann");
    const id = d.createWidget({ type: "html" }, "Ann");
    d.setWidgetState(id, "count", 3, "Ann");
    expect(d.widgetState(id)).toEqual({ count: 3 });
  });
});
