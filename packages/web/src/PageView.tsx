import { useRef, useState, useSyncExternalStore } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isTypedWidget, PAGE_WIDTHS, type OrderTarget, type PageWidth, type Widget } from "@peerdash/core";
import { HtmlFrame } from "./HtmlFrame";
import { TypedBody } from "./TypedWidgets";
import { Markdown, NoteEditor } from "./WidgetNode";
import { BlockBar, blockEvents, label, useOrderedView, useRing } from "./Ordered";
import { frameFeedback } from "./frame";
import { useCanvas } from "./hooks";

const MIN_FRAME = 40;
// A widget that sizes itself to the iframe (e.g. 100vh plus padding) would grow forever.
const MAX_FRAME = 1600;

const WIDTH_LABEL: Record<PageWidth, string> = { text: "Text width", wide: "Wide", full: "Full width" };

/** The page layout: one reading column of blocks, in page order. */
export function PageView({ selected, onSelect }: { selected: string[]; onSelect: (ids: string[]) => void }) {
  const { doc } = useCanvas();
  const blocks = doc.widgetsIn("page");
  const ids = blocks.map((w) => w.id);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { select, move, dnd, dragging } = useOrderedView({ layout: "page", ids, selected, onSelect, scroller, list });

  return (
    <div
      className={`page-scroll ordered-scroll${dragging ? " is-dragging" : ""}`}
      ref={scroller}
      onClick={(e) => e.target === e.currentTarget && selected.length && select([])}
    >
      <div className="page" ref={list} onClick={(e) => e.target === e.currentTarget && selected.length && select([])}>
        <h1 className="page-title">{doc.title || "Untitled page"}</h1>
        {blocks.length === 0 && <p className="muted page-empty">This page is empty. Add a note, or ask your chatbot to write the page.</p>}
        <DndContext {...dnd} collisionDetection={closestCenter}>
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
  const { doc, author } = useCanvas();
  const [editing, setEditing] = useState(false);
  const sortable = useSortable({ id: w.id });
  const { setNodeRef, transform, transition, isDragging } = sortable;
  const width = w.place.page?.width ?? "text";
  const ring = useRing(w.id);
  const events = blockEvents({ widget: w, selected, selectedIds, prev, next, onSelect, onMove, onEdit: () => setEditing(true) });

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
      {...events}
      onDoubleClick={() => w.type === "note" && setEditing(true)}
    >
      <BlockBar widget={w} prev={prev} next={next} onMove={onMove} sortable={sortable} axis="vertical">
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
      </BlockBar>
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
