import { useEffect, useRef, useState } from "react";
import { CanvasDoc } from "@peerdash/core";
import { canvases, displayName, liveFlag, roomKey, type StoredCanvas } from "./storage";
import { importFile } from "./files";

export function Library() {
  const [list, setList] = useState<StoredCanvas[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const reload = () => canvases.list().then(setList);
  useEffect(() => void reload(), []);

  const create = async () => {
    const doc = CanvasDoc.create("Untitled canvas", displayName.get() || "Guest");
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
        <button className="primary" onClick={create}>
          New canvas
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
    </div>
  );
}
