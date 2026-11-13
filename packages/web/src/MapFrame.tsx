// A map widget in a sandboxed iframe; see map.ts for the security model.

import { useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { DEFAULT_BASEMAP, type BBox, type LngLat, type MapContent } from "@peerdash/core";
import { frameFeedback } from "./frame";
import { mapSrcdoc } from "./map";
import { useDark } from "./hooks";

/** The camera of a map, as the iframe reports it after each move. */
export interface MapCamera {
  center: LngLat;
  zoom: number;
  bearing: number;
  pitch: number;
  bbox: BBox;
  /** True when a person moved the map (drag, wheel, buttons); false for moves by the app. */
  user: boolean;
}

export interface MapHandle {
  /** The longitude and latitude at a point of the iframe, in CSS pixels. */
  unproject(x: number, y: number): Promise<LngLat>;
}

interface Props {
  id: string;
  content: MapContent;
  allow: string[];
  /** Fit the map to this box when it changes (the shared context, for a linked map). */
  follow?: BBox | null;
  /** Change this number to fit the map to `follow` again. */
  refit?: number;
  /** Screen positions of these points come back in `onPoints`. */
  markers?: Record<string, LngLat>;
  /** Extents of other people, drawn as dashed boxes. */
  peers?: { bbox: BBox; colour: string }[];
  onView?: (c: MapCamera) => void;
  onPoints?: (points: Record<string, [number, number]>) => void;
  onClick?: (lngLat: LngLat) => void;
  handle?: Ref<MapHandle>;
  className?: string;
}

export function MapFrame({ id, content, allow, follow, refit = 0, markers, peers, onView, onPoints, onClick, handle, className = "" }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const dark = useDark();
  const allowKey = allow.join(" ");
  const pending = useRef(new Map<number, (ll: LngLat) => void>());
  const nextReq = useRef(1);
  // Callbacks change on each render; the message listener reads the latest.
  const cb = useRef({ onView, onPoints, onClick });
  cb.current = { onView, onPoints, onClick };

  useEffect(() => {
    let live = true;
    setSrcdoc(null);
    mapSrcdoc(allow).then((s) => live && setSrcdoc(s));
    return () => {
      live = false;
    };
    // The iframe document depends on the allow list only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowKey]);

  const message = useMemo(
    () => ({
      __peerdash: true,
      type: "map",
      content,
      basemapUrl: content.basemap === "default" ? DEFAULT_BASEMAP.style : content.basemap === "none" ? null : content.basemap,
      follow: follow ?? null,
      refit,
      markers: markers ?? {},
      dark,
    }),
    [content, follow, refit, markers, dark],
  );
  const post = (m: unknown) => ref.current?.contentWindow?.postMessage(m, "*");

  useEffect(() => {
    if (!srcdoc) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data?.__peerdash) return;
      const m = e.data;
      if (m.type === "ready") {
        frameFeedback.reset(id);
        post(message);
        post({ __peerdash: true, type: "peers", peers: peers ?? [] });
      } else if (m.type === "rendered") frameFeedback.size(id, ref.current?.clientWidth ?? 0, ref.current?.clientHeight ?? 0);
      else if (m.type === "error") frameFeedback.add(id, "error", String(m.text));
      else if (m.type === "view") cb.current.onView?.(m as MapCamera);
      else if (m.type === "points") cb.current.onPoints?.(m.points);
      else if (m.type === "click" && Array.isArray(m.lngLat)) cb.current.onClick?.(m.lngLat as LngLat);
      else if (m.type === "unprojected") {
        pending.current.get(m.req)?.(m.lngLat);
        pending.current.delete(m.req);
      }
    };
    window.addEventListener("message", onMessage);
    post(message);
    return () => window.removeEventListener("message", onMessage);
    // `peers` goes in its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcdoc, message, id]);

  const peersKey = JSON.stringify(peers ?? []);
  useEffect(() => {
    if (srcdoc) post({ __peerdash: true, type: "peers", peers: JSON.parse(peersKey) });
  }, [srcdoc, peersKey]);

  useImperativeHandle(
    handle,
    () => ({
      unproject: (x, y) =>
        new Promise<LngLat>((resolve) => {
          const req = nextReq.current++;
          pending.current.set(req, resolve);
          post({ __peerdash: true, type: "unproject", x, y, req });
        }),
    }),
    [],
  );

  useEffect(() => () => frameFeedback.remove(id), [id]);
  const error = useSyncExternalStore(frameFeedback.subscribe, () => frameFeedback.get(id)?.errors.at(-1));

  return (
    <div className={`map-view ${className}`}>
      {srcdoc ? (
        <iframe ref={ref} className="map-frame nodrag nowheel" title={`Map ${id}`} sandbox="allow-scripts" srcDoc={srcdoc} />
      ) : (
        <div className="muted chart-loading">Loading map…</div>
      )}
      {error && <div className="typed-error map-error">{error}</div>}
    </div>
  );
}
