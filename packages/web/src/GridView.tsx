// The grid layout: a 12-column CSS grid with a fixed row height. The browser
// packs the cells (`grid-auto-flow: dense`), so cells never overlap. A cell
// stores intent only: its order, its span (columns) and its rows.

import { useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GRID_LIMITS, isTypedWidget, type GridPlace, type OrderTarget, type Widget } from "@peerdash/core";
import { HtmlFrame } from "./HtmlFrame";
import { KIND_LABEL, TypedBody } from "./TypedWidgets";
import { Markdown, NoteEditor } from "./WidgetNode";
import { BlockBar, blockEvents, label, useOrderedView, useRing } from "./Ordered";
import { useCanvas } from "./hooks";

/** Row height and gap, in CSS pixels. The CSS reads them from custom properties. */
export const GRID_ROW = 88;
export const GRID_GAP = 16;

// Cells of different sizes cannot swap places while the user drags: the
// dense packing would make them overlap. So only the dragged cell moves, and
// the cell under it shows where the dragged cell goes.
const noShift: SortingStrategy = () => null;

const clampSize = (v: number, max: number) => Math.min(max, Math.max(1, Math.round(v)));

/** The grid layout. */
export function GridView({ selected, onSelect }: { selected: string[]; onSelect: (ids: string[]) => void }) {
  const { doc } = useCanvas();
  const cells = doc.widgetsIn("grid");
  const ids = cells.map((w) => w.id);
  const hidden = doc.widgets().length - cells.length;
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { select, move, dnd, dragging } = useOrderedView({ layout: "grid", ids, selected, onSelect, scroller, list });
  const [resizing, setResizing] = useState(false);
  const clear = (e: { target: unknown; currentTarget: unknown }) => e.target === e.currentTarget && selected.length && select([]);

  return (
    <div className={`grid-scroll ordered-scroll${dragging || resizing ? " is-dragging" : ""}`} ref={scroller} onClick={clear}>
      <div className="grid-wrap" onClick={clear}>
        <h1 className="grid-title">{doc.title || "Untitled dashboard"}</h1>
        {hidden > 0 && (
          <p className="muted grid-note">
            {hidden === 1 ? "1 heading is" : `${hidden} headings are`} not shown. A grid has no headings. They come back when you change the layout to page or canvas.
          </p>
        )}
        {cells.length === 0 && <p className="muted grid-note">This grid is empty. Add a metric, a chart or a table, or ask your chatbot to make the dashboard.</p>}
        <DndContext {...dnd} collisionDetection={closestCenter}>
          <SortableContext items={ids} strategy={noShift}>
            <div className="grid" ref={list} style={{ "--row": `${GRID_ROW}px`, "--gap": `${GRID_GAP}px` } as CSSProperties} onClick={clear}>
              {cells.map((w, i) => (
                <Cell
                  key={w.id}
                  widget={w}
                  index={i}
                  selected={selected.includes(w.id)}
                  selectedIds={selected}
                  prev={ids[i - 1]}
                  next={ids[i + 1]}
                  onSelect={select}
                  onMove={move}
                  onResizing={setResizing}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

interface CellProps {
  widget: Widget;
  index: number;
  selected: boolean;
  selectedIds: string[];
  prev?: string;
  next?: string;
  onSelect: (ids: string[]) => void;
  onMove: (id: string, target: OrderTarget) => void;
  onResizing: (on: boolean) => void;
}

type Size = Pick<GridPlace, "span" | "rows">;

function Cell({ widget: w, index, selected, selectedIds, prev, next, onSelect, onMove, onResizing }: CellProps) {
  const { doc, author } = useCanvas();
  const [editing, setEditing] = useState(false);
  const sortable = useSortable({ id: w.id });
  const { setNodeRef, transform, isDragging, isOver, activeIndex } = sortable;
  const ring = useRing(w.id);
  const stored: Size = { span: w.place.grid?.span ?? 4, rows: w.place.grid?.rows ?? 2 };
  // The size while the user drags an edge. It is written once, on release.
  const [draft, setDraft] = useState<Size | null>(null);
  const size = draft ?? stored;
  const el = useRef<HTMLElement | null>(null);

  const resize = (next: Partial<Size>) => {
    const span = clampSize(next.span ?? stored.span, GRID_LIMITS.span);
    const rows = clampSize(next.rows ?? stored.rows, GRID_LIMITS.rows);
    if (span !== stored.span || rows !== stored.rows) doc.setPlace(w.id, "grid", { span, rows }, author);
  };

  // Alt+Shift+arrows change the size; Alt+arrows (in blockEvents) move.
  const onKey = (e: ReactKeyboardEvent) => {
    if (!e.altKey || !e.shiftKey) return false;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return false;
    resize({ span: stored.span + d[0], rows: stored.rows + d[1] });
    return true;
  };
  const events = blockEvents({ widget: w, selected, selectedIds, prev, next, onSelect, onMove, onEdit: () => setEditing(true), onKey });

  /** Drag the right edge (span), the bottom edge (rows) or the corner (both). Snaps to columns and rows. */
  const startResize = (axis: "x" | "y" | "xy") => (e: ReactPointerEvent<HTMLElement>) => {
    const cell = el.current;
    const grid = cell?.parentElement;
    if (!cell || !grid || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const box = cell.getBoundingClientRect();
    const col = (grid.clientWidth + GRID_GAP) / GRID_LIMITS.span;
    const row = GRID_ROW + GRID_GAP;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: Size = stored;
    onResizing(true);
    const onMoveEvent = (ev: PointerEvent) => {
      last = {
        span: axis === "y" ? stored.span : clampSize((box.width + ev.clientX - x0 + GRID_GAP) / col, GRID_LIMITS.span),
        rows: axis === "x" ? stored.rows : clampSize((box.height + ev.clientY - y0 + GRID_GAP) / row, GRID_LIMITS.rows),
      };
      setDraft(last);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMoveEvent);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      onResizing(false);
      setDraft(null);
      resize(last);
    };
    handle.addEventListener("pointermove", onMoveEvent);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  // Where the dragged cell goes when it is dropped here.
  const drop = isOver && !isDragging && activeIndex >= 0 ? (activeIndex < index ? " drop-after" : " drop-before") : "";

  return (
    <section
      ref={(node) => {
        setNodeRef(node);
        el.current = node;
      }}
      data-block={w.id}
      className={`cell widget widget-${w.type}${selected ? " is-selected" : ""}${isDragging ? " is-lifted" : ""}${draft ? " is-resizing" : ""}${drop}`}
      style={
        {
          "--span": size.span,
          "--rows": size.rows,
          transform: CSS.Translate.toString(transform),
          ...(ring && !selected ? { outline: `2px solid ${ring}`, outlineOffset: 2 } : undefined),
        } as CSSProperties
      }
      tabIndex={0}
      aria-label={`${label(w)}, ${size.span} of 12 columns, ${size.rows} row${size.rows === 1 ? "" : "s"}`}
      aria-selected={selected}
      {...events}
    >
      <div className="widget-header cell-header">
        <span className="widget-kind">{KIND_LABEL[w.type]}</span>
        <span className="widget-title">{w.title}</span>
        <BlockBar widget={w} prev={prev} next={next} onMove={onMove} sortable={sortable} axis="horizontal" className="cell-bar">
          <SizeControl label="Width in columns" short="W" value={size.span} max={GRID_LIMITS.span} onChange={(span) => resize({ span })} className="span-control" />
          <SizeControl label="Height in rows" short="H" value={size.rows} max={GRID_LIMITS.rows} onChange={(rows) => resize({ rows })} />
        </BlockBar>
      </div>
      <div className="widget-body" onDoubleClick={() => w.type === "note" && setEditing(true)}>
        {w.type === "html" ? (
          <HtmlFrame id={w.id} content={w.content} allow={w.allow} />
        ) : isTypedWidget(w.type) ? (
          <TypedBody widget={w as Widget & { type: typeof w.type }} where="grid" />
        ) : editing ? (
          <NoteEditor widget={w} onDone={() => setEditing(false)} />
        ) : (
          <Markdown text={w.content} />
        )}
      </div>
      {draft && (
        <div className="cell-size" aria-hidden="true">
          {size.span} × {size.rows}
        </div>
      )}
      <div className="cell-resize cell-resize-x" onPointerDown={startResize("x")} title="Drag to change the width" aria-hidden="true" />
      <div className="cell-resize cell-resize-y" onPointerDown={startResize("y")} title="Drag to change the height" aria-hidden="true" />
      <div className="cell-resize cell-resize-xy" onPointerDown={startResize("xy")} title="Drag to change the size" aria-hidden="true" />
    </section>
  );
}

/** − n + buttons for a grid size. Keyboard: Alt+Shift+arrows on the cell. */
function SizeControl({
  label: name,
  short,
  value,
  max,
  onChange,
  className = "",
}: {
  label: string;
  short: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  return (
    <span className={`size-control ${className}`} role="group" aria-label={name}>
      <button className="ghost small" disabled={value <= 1} onClick={() => onChange(value - 1)} aria-label={`${name}: less`} title={`${name}: less`}>
        −
      </button>
      <span className="size-value" title={name}>
        {short} {value}
      </span>
      <button className="ghost small" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label={`${name}: more`} title={`${name}: more`}>
        +
      </button>
    </span>
  );
}
