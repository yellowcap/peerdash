// Live sync of one canvas between peers (browsers and agent peers).
//
// Ported from orgmap. The protocol is small because the CRDT does the hard work:
// - when a peer connects, both sides send `hello` with their canvas id and version;
// - each side answers a `hello` with the updates the other is missing;
// - every local change is broadcast as an `update`;
// - `presence` carries name, selection, viewport, activity and widget feedback
//   (never stored).
// Updates can arrive in any order or twice; Loro handles both.

import type { CanvasDoc } from "./doc";

// Type aliases (not interfaces) so they count as JSON for the transport.
export type Hello = {
  canvasId: string;
  version: string; // base64 of Loro's encoded version vector
};

/** The visible part of the canvas, in canvas coordinates. */
export type Viewport = { x: number; y: number; w: number; h: number; zoom: number };

/** What a browser saw when it rendered an html widget. */
export type WidgetFeedback = {
  errors: string[];
  logs: string[];
  width: number;
  height: number;
  at: number;
};

export type Presence = {
  name: string;
  kind: "human" | "agent";
  selectedIds: string[];
  viewport: Viewport | null;
  /** Short text, e.g. "editing Revenue chart". */
  activity: string | null;
  /** widgetId → feedback, only for widgets this peer renders. */
  feedback: Record<string, WidgetFeedback>;
};

export interface Channel<T> {
  send(data: T, to?: string): void;
  on(handler: (data: T, from: string) => void): void;
}

/** What a session needs from the network; see trystero.ts for the real one. */
export interface Transport {
  hello: Channel<Hello>;
  update: Channel<Uint8Array>;
  presence: Channel<Presence>;
  onPeerJoin(handler: (peerId: string) => void): void;
  onPeerLeave(handler: (peerId: string) => void): void;
  leave(): void;
}

export interface Peer extends Presence {
  id: string;
  colour: string;
  /** Set once we have received this peer's state. */
  synced: boolean;
}

export type SessionStatus = "waiting" | "connected" | "closed";

const PEER_COLOURS = ["#2f6690", "#5a7d2a", "#7b4f9d", "#a07a00", "#1f7a74", "#9c3d54", "#5c5c5c"];

export function peerColour(peerId: string): string {
  let h = 0;
  for (const c of peerId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PEER_COLOURS[h % PEER_COLOURS.length];
}

export function emptyPresence(name: string, kind: Presence["kind"]): Presence {
  return { name, kind, selectedIds: [], viewport: null, activity: null, feedback: {} };
}

export type SessionError = "otherCanvas" | null;

export class SyncSession {
  readonly doc: CanvasDoc;
  private transport: Transport;
  private me: Presence;
  private peers = new Map<string, Peer>();
  private rejected = new Set<string>();
  private listeners = new Set<() => void>();
  private stopLocal: () => void;
  private snapshot: { status: SessionStatus; peers: Peer[]; error: SessionError } = { status: "waiting", peers: [], error: null };
  private status: SessionStatus = "waiting";
  private error: SessionError = null;

  constructor(doc: CanvasDoc, transport: Transport, presence: Presence) {
    this.doc = doc;
    this.transport = transport;
    this.me = presence;

    transport.onPeerJoin((id) => {
      this.peers.set(id, { ...emptyPresence("", "human"), id, colour: peerColour(id), synced: false });
      transport.hello.send(this.hello(), id);
      transport.presence.send(this.me, id);
      this.emit();
    });

    transport.onPeerLeave((id) => {
      this.peers.delete(id);
      this.rejected.delete(id);
      this.emit();
    });

    transport.hello.on((msg, from) => {
      if (msg.canvasId && this.doc.id && msg.canvasId !== this.doc.id) {
        // Same link, different canvas: never mix documents.
        this.rejected.add(from);
        this.error = "otherCanvas";
        this.emit();
        return;
      }
      if (this.doc.ready) transport.update.send(this.doc.updatesSince(fromBase64(msg.version)), from);
    });

    transport.update.on((bytes, from) => {
      if (this.rejected.has(from)) return;
      this.doc.applyRemote(bytes);
      const peer = this.peers.get(from);
      if (peer && !peer.synced) {
        peer.synced = true;
        this.emit();
      }
    });

    transport.presence.on((p, from) => {
      const peer = this.peers.get(from) ?? { ...emptyPresence("", "human"), id: from, colour: peerColour(from), synced: false };
      this.peers.set(from, { ...peer, ...sanitisePresence(p) });
      this.emit();
    });

    this.stopLocal = doc.onLocalUpdate((bytes) => transport.update.send(bytes));
  }

  get state() {
    return this.snapshot;
  }

  get presence(): Presence {
    return this.me;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Merge into this peer's presence and broadcast it. */
  setPresence(patch: Partial<Presence>) {
    const next = { ...this.me, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.me)) return;
    this.me = next;
    this.transport.presence.send(this.me);
  }

  leave() {
    this.stopLocal();
    this.transport.leave();
    this.peers.clear();
    this.status = "closed";
    this.emit();
  }

  private hello(): Hello {
    return { canvasId: this.doc.id, version: toBase64(this.doc.versionBytes()) };
  }

  private emit() {
    if (this.status !== "closed") this.status = this.peers.size > 0 ? "connected" : "waiting";
    this.snapshot = { status: this.status, peers: [...this.peers.values()], error: this.error };
    this.listeners.forEach((l) => l());
  }
}

// Presence comes from other peers: keep only the fields we know, with sane types.
function sanitisePresence(p: Partial<Presence>): Presence {
  return {
    name: typeof p.name === "string" ? p.name.slice(0, 80) : "",
    kind: p.kind === "agent" ? "agent" : "human",
    selectedIds: Array.isArray(p.selectedIds) ? p.selectedIds.filter((s) => typeof s === "string").slice(0, 500) : [],
    viewport: p.viewport && typeof p.viewport === "object" ? p.viewport : null,
    activity: typeof p.activity === "string" ? p.activity.slice(0, 200) : null,
    feedback: p.feedback && typeof p.feedback === "object" ? p.feedback : {},
  };
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
