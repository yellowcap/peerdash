// The agent peer: holds a Loro copy of each open canvas, keeps it on disk, and
// syncs it with browsers over the same protocol they use among themselves.

import { UndoManager, type VersionVector } from "loro-crdt";
import {
  CanvasDoc,
  emptyPresence,
  generateKey,
  parseLink,
  shareLink,
  SyncSession,
  DEFAULT_APP_URL,
  type Change,
  type Peer,
  type Transport,
} from "@peerdash/core";
import { Store } from "./store";

export interface OpenCanvas {
  doc: CanvasDoc;
  session: SyncSession;
  key: string;
  undo: UndoManager;
  /** What the chat has seen; "changes since your last look" starts here. */
  lastSeen: VersionVector;
}

export type Connect = (key: string) => Promise<Transport>;

export class AgentPeer {
  readonly name: string;
  readonly appUrl: string;
  private store: Store;
  private connect: Connect;
  private open = new Map<string, OpenCanvas>();
  private activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: { name: string; appUrl?: string; store?: Store; connect: Connect }) {
    this.name = opts.name;
    this.appUrl = opts.appUrl ?? DEFAULT_APP_URL;
    this.store = opts.store ?? new Store();
    this.connect = opts.connect;
  }

  link(c: OpenCanvas): string {
    return shareLink(this.appUrl, c.doc.id, c.key);
  }

  async create(title: string): Promise<OpenCanvas> {
    const doc = CanvasDoc.create(title, this.name);
    const key = generateKey();
    this.store.setRoomKey(doc.id, key);
    this.store.saveCanvas(doc.id, doc.snapshot());
    return this.start(doc, key);
  }

  /** Join from a share link. Waits up to `waitMs` for the first sync if the canvas is new here. */
  async join(link: string, waitMs = 20000): Promise<OpenCanvas> {
    const parsed = parseLink(link);
    if (!parsed) throw new Error("Not a peerdash share link. It should contain #/join/<canvas id>/<key>.");
    const { canvasId, key } = parsed;
    this.store.setRoomKey(canvasId, key);
    const running = this.open.get(canvasId);
    if (running && running.key === key) return running;
    running?.session.leave();
    this.open.delete(canvasId);
    const saved = this.store.loadCanvas(canvasId);
    const doc = saved ? CanvasDoc.fromSnapshot(saved) : new CanvasDoc();
    const c = await this.start(doc, key, canvasId);
    if (!doc.ready) await this.waitFor(c, () => doc.ready, waitMs);
    if (!doc.ready) throw new Error("Joined the room, but no peer has sent the canvas yet. Ask the user to keep the canvas open in their browser, then try again.");
    c.lastSeen = doc.version();
    return c;
  }

  /** An open canvas, reopening it from disk (and going live) if needed. */
  async get(id: string): Promise<OpenCanvas> {
    const running = this.open.get(id);
    if (running) return running;
    const saved = this.store.loadCanvas(id);
    const key = this.store.roomKey(id);
    if (!saved || !key) throw new Error(`Unknown canvas ${id}. Use list_dashboards, or join with a share link.`);
    return this.start(CanvasDoc.fromSnapshot(saved), key);
  }

  /** Only one canvas is open: allow tools to omit the id. */
  async resolve(id?: string): Promise<OpenCanvas> {
    if (id) return this.get(id);
    if (this.open.size === 1) return [...this.open.values()][0];
    if (this.open.size === 0) throw new Error("No canvas is open. Use new_dashboard or join first.");
    throw new Error(`Several canvases are open (${[...this.open.keys()].join(", ")}). Pass dashboard_id.`);
  }

  list(): { id: string; title: string; widgets: number; open: boolean; link: string | null }[] {
    return this.store.canvasIds().map((id) => {
      const running = this.open.get(id);
      const doc = running?.doc ?? CanvasDoc.fromSnapshot(this.store.loadCanvas(id)!);
      const key = this.store.roomKey(id);
      return { id, title: doc.title, widgets: doc.widgets().length, open: !!running, link: key ? shareLink(this.appUrl, id, key) : null };
    });
  }

  leave(id: string) {
    const c = this.open.get(id);
    if (!c) return;
    c.session.leave();
    this.save(c);
    this.open.delete(id);
  }

  leaveAll() {
    for (const id of [...this.open.keys()]) this.leave(id);
  }

  peers(c: OpenCanvas): Peer[] {
    return c.session.state.peers;
  }

  /** Changes by others since the chat last looked; moves the mark forward. */
  takeChanges(c: OpenCanvas): Change[] {
    const me = c.doc.loro.peerIdStr;
    const changes = c.doc.changesSince(c.lastSeen).filter((ch) => ch.peer !== me);
    c.lastSeen = c.doc.version();
    return changes;
  }

  /** Show browsers what the agent is doing: highlight widgets and a short status. */
  showActivity(c: OpenCanvas, activity: string, widgetIds: string[]) {
    c.session.setPresence({ activity, selectedIds: widgetIds });
    clearTimeout(this.activityTimers.get(c.doc.id));
    this.activityTimers.set(
      c.doc.id,
      setTimeout(() => c.session.setPresence({ activity: null }), 8000),
    );
  }

  /** Resolves true on the next change by another peer, false on timeout. */
  waitForRemoteChange(c: OpenCanvas, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const stop = c.doc.subscribe((remote) => {
        if (!remote) return;
        clearTimeout(timer);
        stop();
        resolve(true);
      });
      const timer = setTimeout(() => {
        stop();
        resolve(false);
      }, timeoutMs);
    });
  }

  private async start(doc: CanvasDoc, key: string, idHint?: string): Promise<OpenCanvas> {
    const transport = await this.connect(key);
    const session = new SyncSession(doc, transport, emptyPresence(this.name, "agent"));
    const c: OpenCanvas = {
      doc,
      session,
      key,
      undo: new UndoManager(doc.loro, { mergeInterval: 0, maxUndoSteps: 200 }),
      lastSeen: doc.version(),
    };
    const id = doc.id || idHint!;
    this.open.set(id, c);
    let timer: ReturnType<typeof setTimeout> | undefined;
    doc.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => this.save(c), 200);
    });
    return c;
  }

  private save(c: OpenCanvas) {
    if (c.doc.ready) this.store.saveCanvas(c.doc.id, c.doc.snapshot());
  }

  private waitFor(c: OpenCanvas, done: () => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (done()) return resolve();
      const stop = c.doc.subscribe(() => {
        if (!done()) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
      const timer = setTimeout(() => {
        stop();
        resolve();
      }, ms);
    });
  }
}
