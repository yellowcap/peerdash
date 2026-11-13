import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Announcements,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isTypedWidget, PAGE_WIDTHS, readTyped, type OrderTarget, type PageWidth, type Widget } from "@peerdash/core";
import { HtmlFrame } from "./HtmlFrame";
import { KIND_LABEL, TypedBody } from "./TypedWidgets";
import { Markdown, NoteEditor } from "./WidgetNode";
import { frameFeedback } from "./frame";
import { useCanvas, useDocVersion } from "./hooks";

const MIN_FRAME = 40;
// A widget that sizes itself to the iframe (e.g. 100vh plus padding) would grow forever.
const MAX_FRAME = 1600;

const WIDTH_LABEL: Record<PageWidth, string> = { text: "Text width", wide: "Wide", full: "Full width" };

function label(w: Widget | null | undefined): string {
  if (!w) return "block";
  if (w.title) return w.title;
  if (w.type === "heading") {
    const r = readTyped("heading", w.content);
    if ("data" in r) return r.data.text;
  }
  return w.type === "html" ? "HTML block" : KIND_LABEL[w.type];
}

/** Ids of the blocks that are at least partly in view, in page order. */
export function blocksInView(): string[] {
  const root = document.querySelector(".page-scroll");
  if (!root) return [];
  const r = root.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLElement>("[data-block]")]
    .filter((el) => {
      const b = el.getBoundingClientRect();
      return b.bottom > r.top && b.top < r.bottom;
    })
    .map((el) => el.dataset.block!);
}

/** The page layout: one reading column of blocks, in page order. */
export function PageView({ selected, onSelect }: { selected: string[]; onSelect: (ids: string[]) => void }) {
  const { doc, session, author } = useCanvas();
  const version = useDocVersion(doc);
  const blocks = doc.readingOrder("page");
  const ids = blocks.map((w) => w.id);
  const scroller = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  void version;

  const select = useCallback(
    (next: string[]) => {
      onSelect(next);
      session?.setPresence({ selectedIds: next });
    },
    [onSelect, session],
  );

  // Drop selected ids that another peer deleted.
  useEffect(() => {
    const live = selected.filter((id) => doc.widget(id));
    if (live.length !== selected.length) select(live);
  }, [version, selected, doc, select]);

  const move = useCallback((id: string, target: OrderTarget) => doc.moveInOrder(id, "page", target, author), [doc, author]);

  // Delete and Escape, as on the canvas. Inputs keep their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
        e.preventDefault();
        doc.deleteWidgets(selected, author);
        select([]);
      } else if (e.key === "Escape" && selected.length) select([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, author, selected, select]);

  // A click into an html block goes to its iframe, not to this page. The window loses focus then.
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const el = document.activeElement;
        const id = el instanceof HTMLIFrameElement ? el.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
        if (id && !(selected.length === 1 && selected[0] === id)) select([id]);
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [selected, select]);

  // "Here" on a page: the blocks in view, in reading order.
  useEffect(() => {
    if (!session) return;
    session.setPresence({ viewport: null });
    const root = scroller.current;
    if (!root) return;
    const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      clearTimeout(timer);
      timer = setTimeout(() => session.setPresence({ visibleIds: doc.readingOrder("page").map((w) => w.id).filter((id) => seen.has(id)) }), 250);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.block;
          if (!id) continue;
          if (e.isIntersecting) seen.add(id);
          else seen.delete(id);
        }
        send();
      },
      { root },
    );
    const observeAll = () => root.querySelectorAll("[data-block]").forEach((el) => io.observe(el));
    observeAll();
    // Blocks come, go and change order: observe them again. They are children of `.page`.
    const mo = new MutationObserver(() => {
      io.disconnect();
      seen.clear();
      observeAll();
    });
    if (root.firstElementChild) mo.observe(root.firstElementChild, { childList: true });
    return () => {
      clearTimeout(timer);
      io.disconnect();
      mo.disconnect();
      session.setPresence({ visibleIds: undefined });
    };
  }, [session, doc]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    move(String(active.id), to > from ? { after: String(over.id) } : { before: String(over.id) });
  };

  const name = (id: string | number) => label(doc.widget(String(id)));
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${name(active.id)} is over ${name(over.id)}.` : `${name(active.id)} is not over a block.`),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${name(active.id)} at ${name(over.id)}.` : `Dropped ${name(active.id)}.`),
    onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
  };

  return (
    <div
      className={`page-scroll${dragging ? " is-dragging" : ""}`}
      ref={scroller}
      onClick={(e) => e.target === e.currentTarget && selected.length && select([])}
    >
      <div className="page" onClick={(e) => e.target === e.currentTarget && selected.length && select([])}>
        <h1 className="page-title">{doc.title || "Untitled page"}</h1>
        {blocks.length === 0 && <p className="muted page-empty">This page is empty. Add a note, or ask your chatbot to write the page.</p>}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setDragging(true)}
          onDragCancel={() => setDragging(false)}
          onDragEnd={onDragEnd}
          accessibility={{ announcements, screenReaderInstructions: { draggable: "To move a block, press Space or Enter. Use the arrow keys to move it, then press Space or Enter to drop it, or Escape to cancel." } }}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {blocks.map((w, i) => (
              <Block
                key={w.id}
                widget={w}
                selected={selected.includes(w.id)}
                prev={ids[i - 1]}
                next={ids[i + 1]}
                onSelect={select}
                selectedIds={selected}
                onMove={move}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

interface BlockProps {
  widget: Widget;
  selected: boolean;
  selectedIds: string[];
  prev?: string;
  next?: string;
  onSelect: (ids: string[]) => void;
  onMove: (id: string, target: OrderTarget) => void;
}

function Block({ widget: w, selected, selectedIds, prev, next, onSelect, onMove }: BlockProps) {
  const { doc, author, remoteSelection } = useCanvas();
  const [editing, setEditing] = useState(false);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const width = w.place.page?.width ?? "text";
  const peers = remoteSelection.get(w.id) ?? [];
  const openComments = doc.comments(w.id).filter((c) => !c.resolved).length;
  const ring = peers[0]?.colour;

  const click = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, select, textarea, a")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) onSelect(selected ? selectedIds.filter((id) => id !== w.id) : [...selectedIds, w.id]);
    else if (!(selected && selectedIds.length === 1)) onSelect([w.id]);
  };
  const keys = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selected && w.type === "note" && e.key === "Enter") setEditing(true);
      else onSelect([w.id]);
    } else if (e.altKey && e.key === "ArrowUp" && prev) {
      e.preventDefault();
      onMove(w.id, { before: prev });
    } else if (e.altKey && e.key === "ArrowDown" && next) {
      e.preventDefault();
      onMove(w.id, { after: next });
    }
  };

  return (
    <section
      ref={setNodeRef}
      data-block={w.id}
      className={`block block-${w.type} block-${width}${selected ? " is-selected" : ""}${isDragging ? " is-lifted" : ""}`}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        ...(ring && !selected ? { outline: `2px solid ${ring}`, outlineOffset: 2 } : undefined),
      }}
      tabIndex={0}
      aria-label={label(w)}
      aria-selected={selected}
      onClick={click}
      onKeyDown={keys}
      onDoubleClick={() => w.type === "note" && setEditing(true)}
    >
      <div className="block-bar">
        {peers.map((p) => (
          <span key={p.id} className="peer-tag" style={{ background: p.colour }} title={p.activity ?? undefined}>
            {p.kind === "agent" ? "✦ " : ""}
            {p.name || "Guest"}
          </span>
        ))}
        {openComments > 0 && (
          <span className="comment-badge" title={`${openComments} open comment${openComments === 1 ? "" : "s"}`}>
            💬 {openComments}
          </span>
        )}
        <span className="block-tools">
          <button ref={setActivatorNodeRef} className="ghost small drag-handle" aria-label={`Drag to move ${label(w)}`} title="Drag to move" {...attributes} {...listeners}>
            ⠿
          </button>
          <button className="ghost small" disabled={!prev} onClick={() => prev && onMove(w.id, { before: prev })} aria-label="Move up" title="Move up (Alt+↑)">
            ↑
          </button>
          <button className="ghost small" disabled={!next} onClick={() => next && onMove(w.id, { after: next })} aria-label="Move down" title="Move down (Alt+↓)">
            ↓
          </button>
          <select
            className="width-select"
            value={width}
            aria-label="Block width"
            onChange={(e) => doc.setPlace(w.id, "page", { width: e.target.value as PageWidth }, author)}
          >
            {PAGE_WIDTHS.map((k) => (
              <option key={k} value={k}>
                {WIDTH_LABEL[k]}
              </option>
            ))}
          </select>
        </span>
      </div>
      {w.type === "html" ? (
        <figure className="block-figure">
          {w.title && <figcaption>{w.title}</figcaption>}
          <PageFrame widget={w} />
        </figure>
      ) : w.type === "heading" ? (
        <TypedBody widget={w as Widget & { type: "heading" }} where="page" />
      ) : isTypedWidget(w.type) ? (
        <figure className="block-figure">
          {w.title && <figcaption>{w.title}</figcaption>}
          <TypedBody widget={w as Widget & { type: typeof w.type }} where="page" />
        </figure>
      ) : editing ? (
        <NoteEditor widget={w} onDone={() => setEditing(false)} />
      ) : (
        <Markdown text={w.content} />
      )}
    </section>
  );
}

/** An html block: as tall as its content, else as tall as on the canvas. */
function PageFrame({ widget: w }: { widget: Widget }) {
  const reported = useSyncExternalStore(frameFeedback.subscribe, () => frameFeedback.contentHeight(w.id));
  const height = reported > 0 ? Math.min(MAX_FRAME, Math.max(MIN_FRAME, reported)) : w.h;
  return (
    // content-box: the border goes outside, so the iframe gets the full height and needs no scroll bar.
    <div className="block-frame" style={{ height, boxSizing: "content-box" }}>
      <HtmlFrame id={w.id} content={w.content} allow={w.allow} />
    </div>
  );
}
