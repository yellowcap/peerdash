import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { UndoManager } from "loro-crdt";
import {
  CanvasDoc,
  DEFAULT_SIZE,
  emptyPresence,
  freeSpot,
  generateKey,
  isTypedWidget,
  pageTarget,
  shareLink,
  spotInView,
  STARTER_CONTENT,
  SyncSession,
  type Layout,
  type Peer,
  type WidgetType,
} from "@peerdash/core";
import { AddMenu } from "./AddMenu";
import { Board } from "./Board";
import { blocksInView, PageView } from "./PageView";
import { LayoutSelect } from "./LayoutSelect";
import { Inspector } from "./Inspector";
import { AgentSetup } from "./AgentSetup";
import { frameFeedback } from "./frame";
import { acquireTransport } from "./connection";
import { CanvasContext, useDocVersion, useSessionState } from "./hooks";
import { canvases, displayName, liveFlag, roomKey } from "./storage";
import { downloadSnapshot } from "./files";

export function CanvasPage({ id }: { id: string }) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    canvases.get(id).then((stored) => {
      if (!cancelled) setDoc(stored ? CanvasDoc.fromSnapshot(stored.snapshot) : new CanvasDoc());
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!doc) return <div className="centre muted">Loading…</div>;
  return (
    <ReactFlowProvider>
      <CanvasView id={id} doc={doc} />
    </ReactFlowProvider>
  );
}

function CanvasView({ id, doc }: { id: string; doc: CanvasDoc }) {
  const version = useDocVersion(doc);
  const [name, setName] = useState(displayName.get());
  const author = name || "Guest";
  const [live, setLive] = useState(() => liveFlag.get(id) && !!roomKey.get(id));
  const [key, setKey] = useState(() => roomKey.get(id));
  const [session, setSession] = useState<SyncSession | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const sessionState = useSessionState(session);
  const flow = useReactFlow();

  // Live session.
  useEffect(() => {
    if (!live || !key) return;
    let s: SyncSession | null = null;
    let cancelled = false;
    acquireTransport(key).then((t) => {
      if (cancelled) return t.leave();
      s = new SyncSession(doc, t, { ...emptyPresence(author, "human"), feedback: frameFeedback.all() });
      setSession(s);
    });
    return () => {
      cancelled = true;
      s?.leave();
      setSession(null);
    };
    // The name is sent through presence below, not by reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, key, doc]);

  useEffect(() => session?.setPresence({ name: author }), [session, author]);
  // A new session starts with an empty selection: send the current one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => session?.setPresence({ selectedIds: selected }), [session]);
  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return frameFeedback.subscribe((all) => {
      clearTimeout(timer);
      timer = setTimeout(() => session.setPresence({ feedback: all }), 300);
    });
  }, [session]);

  // Save every change, coalesced, and when the page is hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (!doc.ready) return;
      void canvases.put({ id: doc.id, title: doc.title, snapshot: doc.snapshot(), updatedAt: Date.now() });
    };
    const stop = doc.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(save, 300);
    });
    const onHide = () => document.visibilityState === "hidden" && save();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      stop();
      clearTimeout(timer);
      save();
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [doc]);

  // Undo/redo of this browser's own changes.
  const undo = useMemo(() => new UndoManager(doc.loro, { mergeInterval: 500, maxUndoSteps: 200 }), [doc]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) undo.redo();
        else undo.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const remoteSelection = useMemo(() => {
    const m = new Map<string, Peer[]>();
    for (const p of sessionState.peers) for (const wid of p.selectedIds) m.set(wid, [...(m.get(wid) ?? []), p]);
    return m;
  }, [sessionState.peers]);

  const ctx = useMemo(() => ({ doc, session, author, remoteSelection }), [doc, session, author, remoteSelection]);

  // A new layout has a new view: start with nothing selected.
  const layout = doc.layout;
  const shownLayout = useRef(layout);
  useEffect(() => {
    if (shownLayout.current === layout) return;
    shownLayout.current = layout;
    setSelected([]);
    session?.setPresence({ selectedIds: [] });
  }, [layout, session]);

  const addWidget = useCallback((type: WidgetType) => {
    const content = isTypedWidget(type) ? STARTER_CONTENT[type] : "";
    const size = DEFAULT_SIZE[type];
    if (doc.layout === "page") {
      const target = pageTarget(doc, "auto", { selectedIds: selected, visibleIds: blocksInView() });
      const nid = doc.createWidget({ type, content, ...freeSpot(doc.widgets(), size.w, size.h), at: { page: target } }, author);
      setSelected([nid]);
      session?.setPresence({ selectedIds: [nid] });
      requestAnimationFrame(() => document.querySelector(`[data-block="${nid}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return;
    }
    // A free spot in view, so a new widget does not cover the last one.
    const el = document.querySelector(".board")?.getBoundingClientRect();
    const a = el ? flow.screenToFlowPosition({ x: el.left, y: el.top }) : { x: 0, y: 0 };
    const z = el ? flow.screenToFlowPosition({ x: el.right, y: el.bottom }) : { x: 800, y: 600 };
    const view = { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y, zoom: 1 };
    doc.createWidget({ type, content, ...spotInView(doc.widgets(), size.w, size.h, view) }, author);
  }, [doc, flow, author, selected, session]);

  const goLive = () => {
    const k = key ?? generateKey();
    roomKey.set(id, k);
    liveFlag.set(id, true);
    setKey(k);
    setLive(true);
  };
  const stopLive = () => {
    liveFlag.set(id, false);
    setLive(false);
  };
  const newLink = () => {
    const k = generateKey();
    roomKey.set(id, k);
    setKey(k);
  };

  const inspected = selected.length === 1 ? doc.widget(selected[0]) : null;
  const link = key ? shareLink(`${location.origin}${location.pathname}`, id, key) : "";
  void version;

  if (!doc.ready && !(live && key)) {
    // Usually a copied address bar (#/c/<id>): it has no room key, so there is no room to join.
    return (
      <div className="centre">
        <div className="waiting">
          <h2>This link can’t open the canvas</h2>
          <p className="muted">
            This canvas is not in this browser, and the link has no room key. Links copied from the address bar never contain the key.
          </p>
          <p className="muted">
            Ask for the share link: the person who has the canvas opens <strong>Share</strong> and copies the link there. It looks like{" "}
            <code>…/#/join/…</code>.
          </p>
          <a href="#/">Back to my canvases</a>
        </div>
      </div>
    );
  }

  if (!doc.ready) {
    return (
      <div className="centre">
        <div className="waiting">
          <h2>Joining canvas…</h2>
          <p className="muted">Waiting for someone who has this canvas to come online. Keep this page open.</p>
          <p className="muted">Status: {sessionState.status}</p>
          <a href="#/">Back to my canvases</a>
        </div>
      </div>
    );
  }

  return (
    <CanvasContext.Provider value={ctx}>
      <div className="canvas-page">
        <header className="toolbar">
          <a href="#/" className="brand" title="My canvases">
            peerdash
          </a>
          <input
            className="title-input"
            defaultValue={doc.title}
            key={doc.title}
            onBlur={(e) => e.target.value !== doc.title && doc.setTitle(e.target.value, author)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Canvas title"
          />
          <div className="tools">
            <LayoutSelect value={layout} onChange={(l: Layout) => l !== doc.layout && doc.setLayout(l, author)} />
            <AddMenu onAdd={addWidget} />
            <button className="ghost" onClick={() => undo.undo()} disabled={!undo.canUndo()} title="Undo (Ctrl+Z)">
              ↶
            </button>
            <button className="ghost" onClick={() => undo.redo()} disabled={!undo.canRedo()} title="Redo (Ctrl+Shift+Z)">
              ↷
            </button>
            <button className="ghost" onClick={() => downloadSnapshot(doc)} title="Download a .peerdash file">
              Save file
            </button>
          </div>
          <div className="peers">
            {sessionState.peers.map((p) => (
              <span key={p.id} className="peer" style={{ background: p.colour }} title={p.activity ?? (p.kind === "agent" ? "Agent" : "Person")}>
                {p.kind === "agent" ? "✦ " : ""}
                {p.name || "Guest"}
                {p.activity ? <em> · {p.activity}</em> : null}
              </span>
            ))}
          </div>
          <button className={live ? "live" : "primary"} onClick={() => setShareOpen((o) => !o)}>
            {live ? `Live · ${sessionState.peers.length}` : "Share"}
          </button>
        </header>

        {shareOpen && (
          <div className="share-panel">
            <label>
              Your name
              <input
                value={name}
                placeholder="Guest"
                onChange={(e) => {
                  setName(e.target.value);
                  displayName.set(e.target.value);
                }}
              />
            </label>
            {!live ? (
              <>
                <p>Go live to edit this canvas together. People and chatbots join with a link. Data goes directly between browsers.</p>
                <button className="primary" onClick={goLive}>
                  Go live
                </button>
              </>
            ) : (
              <>
                <p>Anyone with this link can edit. Keep it private.</p>
                <div className="copy-row">
                  <input readOnly value={link} onFocus={(e) => e.target.select()} />
                  <button onClick={() => navigator.clipboard.writeText(link)}>Copy</button>
                </div>
                <div className="hint">
                  <strong>Add your chatbot</strong>
                  <AgentSetup link={link} />
                </div>
                <div className="row">
                  <button onClick={newLink} title="Old links stop working">
                    New link
                  </button>
                  <button className="ghost" onClick={stopLive}>
                    Stop live
                  </button>
                </div>
              </>
            )}
            {sessionState.error === "otherCanvas" && <p className="error">A peer with this link has a different canvas. Their changes are ignored.</p>}
          </div>
        )}

        <div className="workspace">
          {layout === "page" ? <PageView selected={selected} onSelect={setSelected} /> : <Board onSelect={setSelected} />}
          {inspected && <Inspector key={inspected.id} widget={inspected} onClose={() => setSelected([])} />}
        </div>
      </div>
    </CanvasContext.Provider>
  );
}
