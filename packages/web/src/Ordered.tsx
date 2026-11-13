// Shared parts of the ordered layouts (page and grid): selection, keys,
// presence ("here" = the widgets in view), drag to reorder with dnd-kit, and
// the block toolbar.

import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { KeyboardSensor, PointerSensor, useSensor, useSensors, type Announcements, type DndContextProps, type DragEndEvent } from "@dnd-kit/core";
import { sortableKeyboardCoordinates, type useSortable } from "@dnd-kit/sortable";
import { readTyped, type OrderedLayout, type OrderTarget, type Widget } from "@peerdash/core";
import { KIND_LABEL } from "./TypedWidgets";
import { useCanvas, useDocVersion } from "./hooks";

export function label(w: Widget | null | undefined): string {
  if (!w) return "block";
  if (w.title) return w.title;
  if (w.type === "heading") {
    const r = readTyped("heading", w.content);
    if ("data" in r) return r.data.text;
  }
  return w.type === "html" ? "HTML block" : KIND_LABEL[w.type];
}

/** Ids of the widgets that are at least partly in view, in layout order. */
export function blocksInView(): string[] {
  const root = document.querySelector(".ordered-scroll");
  if (!root) return [];
  const r = root.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLElement>("[data-block]")]
    .filter((el) => {
      const b = el.getBoundingClientRect();
      return b.bottom > r.top && b.top < r.bottom;
    })
    .map((el) => el.dataset.block!);
}

interface Options {
  layout: OrderedLayout;
  ids: string[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  /** The scroll box. "Here" is what is in view in it. */
  scroller: RefObject<HTMLElement | null>;
  /** The element whose children are the blocks. */
  list: RefObject<HTMLElement | null>;
}

/** Selection, keys, presence and drag for a page or grid. */
export function useOrderedView({ layout, ids, selected, onSelect, scroller, list }: Options) {
  const { doc, session, author } = useCanvas();
  const version = useDocVersion(doc);
  const [dragging, setDragging] = useState(false);

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

  const move = useCallback((id: string, target: OrderTarget) => doc.moveInOrder(id, layout, target, author), [doc, layout, author]);

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

  // "Here" on a page or grid: the widgets in view, in layout order.
  useEffect(() => {
    if (!session) return;
    session.setPresence({ viewport: null });
    const root = scroller.current;
    if (!root) return;
    const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      clearTimeout(timer);
      timer = setTimeout(() => session.setPresence({ visibleIds: doc.widgetsIn(layout).map((w) => w.id).filter((id) => seen.has(id)) }), 250);
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
    // Blocks come, go and change order: observe them again.
    const mo = new MutationObserver(() => {
      io.disconnect();
      seen.clear();
      observeAll();
    });
    if (list.current) mo.observe(list.current, { childList: true });
    return () => {
      clearTimeout(timer);
      io.disconnect();
      mo.disconnect();
      session.setPresence({ visibleIds: undefined });
    };
  }, [session, doc, layout, scroller, list]);

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

  const dnd: DndContextProps = {
    sensors,
    onDragStart: () => setDragging(true),
    onDragCancel: () => setDragging(false),
    onDragEnd,
    accessibility: {
      announcements,
      screenReaderInstructions: {
        draggable: "To move a block, press Space or Enter. Use the arrow keys to move it, then press Space or Enter to drop it, or Escape to cancel.",
      },
    },
  };

  return { select, move, dnd, dragging, version };
}

interface BlockEvents {
  widget: Widget;
  selected: boolean;
  selectedIds: string[];
  prev?: string;
  next?: string;
  onSelect: (ids: string[]) => void;
  onMove: (id: string, target: OrderTarget) => void;
  onEdit: () => void;
  /** More keys, e.g. resize in the grid. Return true when the key was used. */
  onKey?: (e: ReactKeyboardEvent) => boolean;
}

/**
 * Click and key handlers of a block. Enter selects (and edits a selected
 * note), Alt+arrow moves the block one place earlier or later.
 */
export function blockEvents({ widget: w, selected, selectedIds, prev, next, onSelect, onMove, onEdit, onKey }: BlockEvents) {
  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, select, textarea, a, input")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) onSelect(selected ? selectedIds.filter((id) => id !== w.id) : [...selectedIds, w.id]);
    else if (!(selected && selectedIds.length === 1)) onSelect([w.id]);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (onKey?.(e)) {
      e.preventDefault();
      return;
    }
    const earlier = e.key === "ArrowUp" || e.key === "ArrowLeft";
    const later = e.key === "ArrowDown" || e.key === "ArrowRight";
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selected && w.type === "note" && e.key === "Enter") onEdit();
      else onSelect([w.id]);
    } else if (e.altKey && !e.shiftKey && earlier && prev) {
      e.preventDefault();
      onMove(w.id, { before: prev });
    } else if (e.altKey && !e.shiftKey && later && next) {
      e.preventDefault();
      onMove(w.id, { after: next });
    }
  };
  return { onClick, onKeyDown };
}

type Sortable = ReturnType<typeof useSortable>;

interface ToolsProps {
  widget: Widget;
  prev?: string;
  next?: string;
  onMove: (id: string, target: OrderTarget) => void;
  sortable: Pick<Sortable, "attributes" | "listeners" | "setActivatorNodeRef">;
  /** Labels and arrows of the move buttons: up/down on a page, left/right in a grid. */
  axis: "vertical" | "horizontal";
  className?: string;
  /** Extra controls, e.g. the page width or the grid size. */
  children?: ReactNode;
}

/** Peer tags, the comment count, and the tools: drag handle, move buttons and extra controls. */
export function BlockBar({ widget: w, prev, next, onMove, sortable, axis, className = "block-bar", children }: ToolsProps) {
  const { doc, remoteSelection } = useCanvas();
  const peers = remoteSelection.get(w.id) ?? [];
  const openComments = doc.comments(w.id).filter((c) => !c.resolved).length;
  const [back, fwd] = axis === "vertical" ? ["↑", "↓"] : ["←", "→"];
  const [backLabel, fwdLabel] = axis === "vertical" ? ["Move up", "Move down"] : ["Move earlier", "Move later"];
  return (
    <div className={className}>
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
        <button
          ref={sortable.setActivatorNodeRef}
          className="ghost small drag-handle"
          aria-label={`Drag to move ${label(w)}`}
          title="Drag to move"
          {...sortable.attributes}
          {...sortable.listeners}
        >
          ⠿
        </button>
        <button className="ghost small" disabled={!prev} onClick={() => prev && onMove(w.id, { before: prev })} aria-label={backLabel} title={`${backLabel} (Alt+${back})`}>
          {back}
        </button>
        <button className="ghost small" disabled={!next} onClick={() => next && onMove(w.id, { after: next })} aria-label={fwdLabel} title={`${fwdLabel} (Alt+${fwd})`}>
          {fwd}
        </button>
        {children}
      </span>
    </div>
  );
}

/** The outline colour of the first remote peer that selected a block. */
export function useRing(id: string): string | undefined {
  const { remoteSelection } = useCanvas();
  return remoteSelection.get(id)?.[0]?.colour;
}
