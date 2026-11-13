import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import type { CanvasDoc, MapContext, Peer, SyncSession } from "@peerdash/core";

/** Re-render on every change of the document; returns a counter. */
export function useDocVersion(doc: CanvasDoc): number {
  const version = useRef(0);
  return useSyncExternalStore(
    (notify) =>
      doc.subscribe(() => {
        version.current++;
        notify();
      }),
    () => version.current,
  );
}

const noSession = { status: "waiting" as const, peers: [] as Peer[], error: null };

export function useSessionState(session: SyncSession | null) {
  return useSyncExternalStore(
    (notify) => (session ? session.subscribe(notify) : () => {}),
    () => (session ? session.state : noSession),
  );
}

export interface CanvasCtx {
  doc: CanvasDoc;
  session: SyncSession | null;
  author: string;
  /** widgetId → remote peers that have it selected. */
  remoteSelection: Map<string, Peer[]>;
}

export const CanvasContext = createContext<CanvasCtx | null>(null);

export function useCanvas(): CanvasCtx {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error("useCanvas outside CanvasContext");
  return ctx;
}

export function useDark(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = matchMedia("(prefers-color-scheme: dark)");
      q.addEventListener("change", cb);
      return () => q.removeEventListener("change", cb);
    },
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

/** The shared map context of the dashboard. The object stays the same until the context changes. */
export function useMapContext(doc: CanvasDoc): MapContext {
  useDocVersion(doc);
  const key = JSON.stringify(doc.context());
  return useMemo(() => JSON.parse(key) as MapContext, [key]);
}
