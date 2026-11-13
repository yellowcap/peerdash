import { useEffect, useRef, useState } from "react";
import { CanvasDoc, type Layout } from "@peerdash/core";
import { LayoutSelect } from "./LayoutSelect";
import { canvases, displayName, liveFlag, roomKey, type StoredCanvas } from "./storage";
import { importFile } from "./files";
import { AgentSetup } from "./AgentSetup";

const NOUN: Record<Layout, string> = { canvas: "canvas", page: "page", grid: "dashboard", map: "map" };

export function Library() {
  const [list, setList] = useState<StoredCanvas[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [layout, setLayout] = useState<Layout>("canvas");

  const reload = () => canvases.list().then(setList);
  useEffect(() => void reload(), []);

  const create = async () => {
    const doc = CanvasDoc.create(`Untitled ${NOUN[layout]}`, displayName.get() || "Guest", undefined, layout);
    await canvases.put({ id: doc.id, title: doc.title, snapshot: doc.snapshot(), updatedAt: Date.now() });
    location.hash = `#/c/${doc.id}`;
  };

  const remove = async (c: StoredCanvas) => {
    if (!confirm(`Delete "${c.title || "Untitled"}" from this browser? Other peers keep their copies.`)) return;
    await canvases.delete(c.id);
    roomKey.set(c.id, null);
    liveFlag.set(c.id, false);
    void reload();
  };

  return (
    <div className="library">
      <header>
        <h1>peerdash</h1>
        <p className="muted">
          A local-first canvas for dashboards. Edit together, peer to peer, and let your chatbot join as one more peer. Canvases stay in this browser.
        </p>
      </header>
      <div className="row">
        <LayoutSelect value={layout} onChange={setLayout} title="Layout of the new dashboard. You can change it later." />
        <button className="primary" onClick={create}>
          New {NOUN[layout]}
        </button>
        <button onClick={() => file.current?.click()}>Open file…</button>
        <input
          ref={file}
          type="file"
          accept=".peerdash"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              location.hash = `#/c/${await importFile(f)}`;
            } catch (err) {
              setError(String((err as Error).message ?? err));
            }
          }}
        />
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="canvas-list">
        {list?.length === 0 && <li className="muted">No canvases yet.</li>}
        {list?.map((c) => (
          <li key={c.id}>
            <a href={`#/c/${c.id}`}>{c.title || "Untitled canvas"}</a>
            {liveFlag.get(c.id) && <span className="badge">live</span>}
            <span className="muted">{new Date(c.updatedAt).toLocaleString()}</span>
            <button className="ghost" onClick={() => remove(c)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      <section className="library-agent">
        <h2>Use it with your chatbot</h2>
        <AgentSetup />
      </section>
    </div>
  );
}
