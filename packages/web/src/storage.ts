// Canvases live in IndexedDB as Loro snapshots. Room keys and the "live" flag
// live in localStorage, outside the document, so a shared .peerdash file never
// grants access to a live session.

export interface StoredCanvas {
  id: string;
  title: string;
  snapshot: Uint8Array;
  updatedAt: number;
}

const DB = "peerdash";
const STORE = "canvases";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const canvases = {
  list: () => tx<StoredCanvas[]>("readonly", (s) => s.getAll()).then((all) => all.sort((a, b) => b.updatedAt - a.updatedAt)),
  get: (id: string) => tx<StoredCanvas | undefined>("readonly", (s) => s.get(id)),
  put: (c: StoredCanvas) => tx("readwrite", (s) => s.put(c)),
  delete: (id: string) => tx("readwrite", (s) => s.delete(id)),
};

function get(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function set(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // Storage unavailable; the setting lasts for this page only.
  }
}

export const roomKey = {
  get: (id: string) => get(`peerdash.room.${id}`),
  set: (id: string, key: string | null) => set(`peerdash.room.${id}`, key),
};

/** Whether this browser reconnects to the live session when the canvas opens. */
export const liveFlag = {
  get: (id: string) => get(`peerdash.live.${id}`) === "1",
  set: (id: string, on: boolean) => set(`peerdash.live.${id}`, on ? "1" : null),
};

export const displayName = {
  get: () => get("peerdash.name") ?? "",
  set: (name: string) => set("peerdash.name", name.trim() || null),
};
