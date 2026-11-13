// The map layout: one background map that fills the view, a side panel of
// widgets in order, overlays pinned to the corners, and markers: cards at a
// longitude and latitude.
//
// The shared extent (`context.bbox`): each person pans their own map freely.
// Their extent is in presence (`mapView`), not in the document, so panning
// makes no commits. The shared extent changes only when a person asks for it:
// "Share my view" writes it once, and "Sync" writes it after each of their own
// moves, when the map settles (debounced, one commit). Every map follows a
// change of the shared extent, but a move that the app made never writes it
// back, so two people in sync mode do not start a loop of commits.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  cleanDatetime,
  isTypedWidget,
  MAP_CORNERS,
  MAP_SLOTS,
  readTyped,
  STARTER_CONTENT,
  type BBox,
  type LngLat,
  type MapCorner,
  type MapSlot,
  type OrderTarget,
  type Widget,
} from "@peerdash/core";
import { MapFrame, type MapCamera, type MapHandle } from "./MapFrame";
import { KIND_LABEL, TypedBody } from "./TypedWidgets";
import { Markdown, NoteEditor } from "./WidgetNode";
import { PageFrame } from "./PageView";
import { BlockBar, blockEvents, label, useOrderedView, useRing } from "./Ordered";
import { useCanvas, useMapContext, useSessionState } from "./hooks";

const SLOT_LABEL: Record<MapSlot, string> = { panel: "Panel", overlay: "Overlay", marker: "Marker" };
const CORNER_LABEL: Record<MapCorner, string> = { "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right" };
/** Wait this long after the map settles before a synced move writes the shared extent. */
const SYNC_DELAY = 700;

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** A map extent as a valid bbox: clamped to the world, null when it crosses the antimeridian. */
function toBBox(b: BBox): BBox | null {
  const c = (v: number, lim: number) => r5(Math.min(lim, Math.max(-lim, v)));
  const out: BBox = [c(b[0], 180), c(b[1], 90), c(b[2], 180), c(b[3], 90)];
  return out[0] < out[2] && out[1] < out[3] ? out : null;
}

function centre(b: BBox): LngLat {
  return [r5((b[0] + b[2]) / 2), r5((b[1] + b[3]) / 2)];
}

/** Map state that the cards need: where to put a new marker, and how to turn a screen point into a place. */
interface MapApi {
  centre: () => LngLat;
  unproject: (x: number, y: number) => Promise<LngLat>;
}

export function MapLayout({ selected, onSelect }: { selected: string[]; onSelect: (ids: string[]) => void }) {
  const { doc, session, author } = useCanvas();
  const { peers } = useSessionState(session);
  const ctx = useMapContext(doc);
  const all = doc.widgetsIn("map");
  const bg = doc.backgroundMap();
  const rest = all.filter((w) => w.id !== bg?.id);
  const slot = (w: Widget) => w.place.map?.slot ?? "panel";
  const panel = rest.filter((w) => slot(w) === "panel");
  const overlays = rest.filter((w) => slot(w) === "overlay");
  const markers = rest.filter((w) => slot(w) === "marker" && w.place.map?.lngLat);
  const ids = panel.map((w) => w.id);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { select, move, dnd, dragging } = useOrderedView({ layout: "map", ids, selected, onSelect, scroller, list });

  const [sync, setSync] = useState(false);
  const [sheet, setSheet] = useState(true);
  const [refit, setRefit] = useState(0);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [points, setPoints] = useState<Record<string, [number, number]>>({});
  const camera = useRef<MapCamera | null>(null);
  const mapBox = useRef<HTMLDivElement>(null);
  const handle = useRef<MapHandle>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const markerKey = JSON.stringify(markers.map((w) => [w.id, w.place.map!.lngLat]));
  const markerPoints = useMemo(() => Object.fromEntries(JSON.parse(markerKey) as [string, LngLat][]), [markerKey]);
  const peerBoxes = peers.filter((p) => p.mapView).map((p) => ({ bbox: p.mapView!.bbox, colour: p.colour }));

  const writeExtent = (b: BBox) => {
    const bbox = toBBox(b);
    if (bbox) doc.setContext({ bbox }, author);
  };

  const onView = (c: MapCamera) => {
    camera.current = c;
    session?.setPresence({ mapView: { bbox: c.bbox, center: [r5(c.center[0]), r5(c.center[1])], zoom: Math.round(c.zoom * 100) / 100 } });
    clearTimeout(syncTimer.current);
    if (sync && c.user) syncTimer.current = setTimeout(() => writeExtent(c.bbox), SYNC_DELAY);
  };
  useEffect(() => () => clearTimeout(syncTimer.current), []);
  // The context bar wraps on a narrow map: top overlays start below it.
  useEffect(() => {
    const box = mapBox.current;
    const bar = box?.querySelector<HTMLElement>(".context-bar");
    if (!box || !bar) return;
    const ro = new ResizeObserver(() => box.style.setProperty("--bar", `${bar.offsetTop + bar.offsetHeight + 8}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [bg?.id]);
  // Off the map layout, this peer has no map view.
  useEffect(() => () => session?.setPresence({ mapView: undefined }), [session]);

  const api: MapApi = {
    centre: () => camera.current?.center.map(r5) as LngLat ?? (ctx.bbox ? centre(ctx.bbox) : [0, 20]),
    unproject: (x, y) => handle.current?.unproject(x, y) ?? Promise.resolve([0, 0]),
  };

  const onMapClick = (lngLat: LngLat) => {
    if (!pickFor) return;
    if (doc.widget(pickFor)) doc.setPlace(pickFor, "map", { slot: "marker", lngLat: [r5(lngLat[0]), r5(lngLat[1])] }, author);
    setPickFor(null);
  };

  const addMap = () => {
    const nid = doc.createWidget({ type: "map", title: "Map", content: STARTER_CONTENT.map, at: { map: "start" } }, author);
    select([nid]);
  };

  const bgData = useMemo(() => (bg ? readTyped("map", bg.content, bg.allow) : null), [bg?.content, bg?.allow.join(" ")]);
  const follow = ctx.bbox ?? null;

  const clear = (e: { target: unknown; currentTarget: unknown }) => e.target === e.currentTarget && selected.length && select([]);
  const props = { selectedIds: selected, onSelect: select, onMove: move, api, onPick: setPickFor };

  return (
    <div className={`maplayout${sheet ? "" : " sheet-closed"}${dragging ? " is-dragging" : ""}${pickFor ? " is-picking" : ""}`}>
      <div className="maplayout-map" ref={mapBox}>
        {bg && bgData && "data" in bgData ? (
          <MapFrame
            id={bg.id}
            content={bgData.data}
            allow={bg.allow}
            follow={follow}
            refit={refit}
            markers={markerPoints}
            peers={peerBoxes}
            onView={onView}
            onPoints={setPoints}
            onClick={onMapClick}
            handle={handle}
            className="map-background"
          />
        ) : bg && bgData && "error" in bgData ? (
          <div className="map-empty">
            <p className="typed-error">The background map has content that is not valid: {bgData.error}</p>
            <button onClick={() => select([bg.id])}>Edit the map</button>
          </div>
        ) : (
          <div className="map-empty">
            <p>This map dashboard has no map yet.</p>
            <button className="primary" onClick={addMap}>
              Add a map
            </button>
          </div>
        )}

        {MAP_CORNERS.map((c) => {
          const here = overlays.filter((w) => (w.place.map?.corner ?? "top-right") === c);
          return here.length ? (
            <div key={c} className={`map-corner corner-${c}`}>
              {here.map((w) => (
                <OverlayCard key={w.id} widget={w} selected={selected.includes(w.id)} {...props} />
              ))}
            </div>
          ) : null;
        })}

        {markers.map((w) =>
          points[w.id] ? <MarkerCard key={w.id} widget={w} at={points[w.id]} selected={selected.includes(w.id)} {...props} /> : null,
        )}

        {bg && (
          <ContextBar
            sync={sync}
            onSync={setSync}
            onShare={() => camera.current && writeExtent(camera.current.bbox)}
            onRefit={() => setRefit((n) => n + 1)}
            onEditMap={() => select([bg.id])}
            picking={pickFor !== null}
            onCancelPick={() => setPickFor(null)}
          />
        )}
      </div>

      <aside className="map-panel" aria-label="Panel">
        <button className="ghost sheet-toggle" onClick={() => setSheet((o) => !o)} aria-expanded={sheet} aria-label={sheet ? "Close the panel" : "Open the panel"}>
          {sheet ? "▾" : "▴"} {panel.length} in panel
        </button>
        <div className="map-panel-scroll ordered-scroll" ref={scroller} onClick={clear}>
          <h1 className="map-title">{doc.title || "Untitled map"}</h1>
          {panel.length === 0 && <p className="muted map-note">The panel is empty. Add a note, a metric or a chart, or ask your chatbot.</p>}
          <DndContext {...dnd} collisionDetection={closestCenter}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="map-panel-list" ref={list} onClick={clear}>
                {panel.map((w, i) => (
                  <PanelCard key={w.id} widget={w} selected={selected.includes(w.id)} prev={ids[i - 1]} next={ids[i + 1]} {...props} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </aside>
    </div>
  );
}

interface CardProps {
  widget: Widget;
  selected: boolean;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onMove: (id: string, target: OrderTarget) => void;
  api: MapApi;
  onPick: (id: string) => void;
}

/** The body of a widget in a panel, overlay or marker card. */
function CardBody({ widget: w, editing, onDone }: { widget: Widget; editing: boolean; onDone: () => void }) {
  if (w.type === "html") return <PageFrame widget={w} />;
  if (isTypedWidget(w.type)) return <TypedBody widget={w as Widget & { type: typeof w.type }} where="page" />;
  if (editing) return <NoteEditor widget={w} onDone={onDone} />;
  return <Markdown text={w.content} />;
}

/** Slot select, overlay corner, and "pick a place" for a marker. */
function SlotControls({ widget: w, api, onPick }: { widget: Widget; api: MapApi; onPick: (id: string) => void }) {
  const { doc, author } = useCanvas();
  const place = w.place.map;
  const slot = place?.slot ?? "panel";
  const setSlot = (s: MapSlot) => doc.setPlace(w.id, "map", s === "marker" ? { slot: s, lngLat: place?.lngLat ?? api.centre() } : { slot: s }, author);
  return (
    <>
      <select className="width-select" value={slot} aria-label="Place on the map" onChange={(e) => setSlot(e.target.value as MapSlot)}>
        {MAP_SLOTS.map((s) => (
          <option key={s} value={s}>
            {SLOT_LABEL[s]}
          </option>
        ))}
      </select>
      {slot === "overlay" && (
        <select className="width-select" value={place?.corner ?? "top-right"} aria-label="Corner" onChange={(e) => doc.setPlace(w.id, "map", { corner: e.target.value as MapCorner }, author)}>
          {MAP_CORNERS.map((c) => (
            <option key={c} value={c}>
              {CORNER_LABEL[c]}
            </option>
          ))}
        </select>
      )}
      <button className="ghost small" onClick={() => onPick(w.id)} title="Click on the map to put this widget there as a marker" aria-label="Pin to a place on the map">
        📍
      </button>
    </>
  );
}

function PanelCard({ widget: w, selected, selectedIds, prev, next, onSelect, onMove, api, onPick }: CardProps & { prev?: string; next?: string }) {
  const [editing, setEditing] = useState(false);
  const sortable = useSortable({ id: w.id });
  const ring = useRing(w.id);
  const events = blockEvents({ widget: w, selected, selectedIds, prev, next, onSelect, onMove, onEdit: () => setEditing(true) });
  return (
    <section
      ref={sortable.setNodeRef}
      data-block={w.id}
      className={`block map-card block-${w.type}${selected ? " is-selected" : ""}${sortable.isDragging ? " is-lifted" : ""}`}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
        ...(ring && !selected ? { outline: `2px solid ${ring}`, outlineOffset: 2 } : undefined),
      }}
      tabIndex={0}
      aria-label={label(w)}
      aria-selected={selected}
      {...events}
      onDoubleClick={() => w.type === "note" && setEditing(true)}
    >
      <BlockBar widget={w} prev={prev} next={next} onMove={onMove} sortable={sortable} axis="vertical">
        <SlotControls widget={w} api={api} onPick={onPick} />
      </BlockBar>
      <Titled widget={w}>
        <CardBody widget={w} editing={editing} onDone={() => setEditing(false)} />
      </Titled>
    </section>
  );
}

function Titled({ widget: w, children }: { widget: Widget; children: ReactNode }) {
  if (!w.title || w.type === "heading") return <>{children}</>;
  return (
    <figure className="block-figure">
      <figcaption>{w.title}</figcaption>
      {children}
    </figure>
  );
}

/** The header of an overlay or marker card: kind, title, peers and slot controls. */
function FloatHeader({ widget: w, api, onPick, children }: { widget: Widget; api: MapApi; onPick: (id: string) => void; children?: ReactNode }) {
  const { remoteSelection } = useCanvas();
  const peers = remoteSelection.get(w.id) ?? [];
  return (
    <div className="widget-header float-header">
      {children}
      <span className="widget-kind">{KIND_LABEL[w.type]}</span>
      <span className="widget-title">{w.title}</span>
      {peers.map((p) => (
        <span key={p.id} className="peer-tag" style={{ background: p.colour }}>
          {p.kind === "agent" ? "✦ " : ""}
          {p.name || "Guest"}
        </span>
      ))}
      <span className="float-tools">
        <SlotControls widget={w} api={api} onPick={onPick} />
      </span>
    </div>
  );
}

function OverlayCard({ widget: w, selected, selectedIds, onSelect, onMove, api, onPick }: CardProps) {
  const [editing, setEditing] = useState(false);
  const ring = useRing(w.id);
  const events = blockEvents({ widget: w, selected, selectedIds, onSelect, onMove, onEdit: () => setEditing(true) });
  return (
    <section
      data-float={w.id}
      className={`widget map-float map-overlay widget-${w.type}${selected ? " is-selected" : ""}`}
      style={ring && !selected ? { outline: `2px solid ${ring}`, outlineOffset: 2 } : undefined}
      tabIndex={0}
      aria-label={`${label(w)}, overlay`}
      aria-selected={selected}
      {...events}
      onDoubleClick={() => w.type === "note" && setEditing(true)}
    >
      <FloatHeader widget={w} api={api} onPick={onPick} />
      <div className="float-body">
        <CardBody widget={w} editing={editing} onDone={() => setEditing(false)} />
      </div>
    </section>
  );
}

/** A card above a pin. Drag the pin handle to move the marker. */
function MarkerCard({ widget: w, at, selected, selectedIds, onSelect, onMove, api, onPick }: CardProps & { at: [number, number] }) {
  const { doc, author } = useCanvas();
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const ring = useRing(w.id);
  const events = blockEvents({ widget: w, selected, selectedIds, onSelect, onMove, onEdit: () => setEditing(true) });

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let d: [number, number] = [0, 0];
    const onMoveEvent = (ev: PointerEvent) => setDrag((d = [ev.clientX - x0, ev.clientY - y0]));
    const onUp = () => {
      el.removeEventListener("pointermove", onMoveEvent);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (Math.abs(d[0]) + Math.abs(d[1]) < 3) {
        setDrag(null);
        return;
      }
      api.unproject(at[0] + d[0], at[1] + d[1]).then((ll) => {
        doc.setPlace(w.id, "map", { lngLat: [r5(ll[0]), r5(ll[1])] }, author);
        setDrag(null);
      });
    };
    el.addEventListener("pointermove", onMoveEvent);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const x = at[0] + (drag?.[0] ?? 0);
  const y = at[1] + (drag?.[1] ?? 0);
  return (
    <div className={`map-marker${selected ? " is-selected" : ""}${drag ? " is-dragging" : ""}`} style={{ transform: `translate(${x}px, ${y}px)` }}>
      <section
        data-float={w.id}
        className={`widget map-float marker-card widget-${w.type}${selected ? " is-selected" : ""}`}
        style={ring && !selected ? { outline: `2px solid ${ring}`, outlineOffset: 2 } : undefined}
        tabIndex={0}
        aria-label={`${label(w)}, marker at ${w.place.map!.lngLat!.join(", ")}`}
        aria-selected={selected}
        {...events}
        onDoubleClick={() => w.type === "note" && setEditing(true)}
      >
        <FloatHeader widget={w} api={api} onPick={onPick}>
          <button className="ghost small drag-handle" onPointerDown={startDrag} aria-label="Drag to move the marker" title="Drag to move the marker">
            ⠿
          </button>
        </FloatHeader>
        <div className="float-body">
          <CardBody widget={w} editing={editing} onDone={() => setEditing(false)} />
        </div>
      </section>
      <span className="marker-pin" aria-hidden="true" />
    </div>
  );
}

/** The shared extent and time, and the sync switch. */
function ContextBar(p: {
  sync: boolean;
  onSync: (on: boolean) => void;
  onShare: () => void;
  onRefit: () => void;
  onEditMap: () => void;
  picking: boolean;
  onCancelPick: () => void;
}) {
  const { doc, author } = useCanvas();
  const ctx = useMapContext(doc);
  const [dateError, setDateError] = useState<string | null>(null);
  const date = ctx.datetime && /^\d{4}-\d{2}-\d{2}$/.test(ctx.datetime) ? ctx.datetime : "";
  const setDate = (v: string) => {
    try {
      doc.setContext({ datetime: v ? cleanDatetime(v) : null }, author);
      setDateError(null);
    } catch (e) {
      setDateError(e instanceof Error ? e.message : String(e));
    }
  };
  if (p.picking) {
    return (
      <div className="context-bar" role="status">
        <span>Click on the map to put the marker there.</span>
        <button className="ghost small" onClick={p.onCancelPick}>
          Cancel
        </button>
      </div>
    );
  }
  const bbox = ctx.bbox ? ctx.bbox.map((v) => v.toFixed(2)).join(", ") : null;
  return (
    <div className="context-bar">
      <span className="context-extent" title={bbox ? `Shared extent: ${bbox} (west, south, east, north)` : "No shared extent. Linked widgets show everything."}>
        {bbox ? "Shared view" : "No shared view"}
      </span>
      <button className="ghost small" onClick={p.onShare} title="Make your current view the shared view (one change)">
        Share my view
      </button>
      {ctx.bbox && (
        <>
          <button className="ghost small" onClick={p.onRefit} title="Go back to the shared view">
            Go to it
          </button>
          <button className="ghost small" onClick={() => doc.setContext({ bbox: null }, author)} title="Remove the shared view" aria-label="Remove the shared view">
            ×
          </button>
        </>
      )}
      <label className="context-sync" title="When on, each of your moves changes the shared view after the map stops">
        <input type="checkbox" checked={p.sync} onChange={(e) => p.onSync(e.target.checked)} /> Sync
      </label>
      <label className="context-date" title={ctx.datetime ? `Shared time: ${ctx.datetime}` : "Shared time"}>
        <span className="sr-only">Shared date</span>
        {date || !ctx.datetime ? (
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={dateError ? true : undefined} />
        ) : (
          <span className="context-datetime">{ctx.datetime}</span>
        )}
      </label>
      {ctx.datetime && (
        <button className="ghost small" onClick={() => setDate("")} title="Remove the shared time" aria-label="Remove the shared time">
          ×
        </button>
      )}
      <button className="ghost small" onClick={p.onEditMap} title="Edit the background map: view, basemap, layers">
        Edit map
      </button>
      {dateError && <span className="error">{dateError}</span>}
    </div>
  );
}
