import { useEffect, useRef, useState } from "react";
import type { WidgetType } from "@peerdash/core";

const ITEMS: { type: WidgetType; label: string; hint: string }[] = [
  { type: "note", label: "Note", hint: "Markdown text" },
  { type: "heading", label: "Heading", hint: "Starts a section" },
  { type: "metric", label: "Metric", hint: "One number, with change and trend" },
  { type: "chart", label: "Chart", hint: "Vega-Lite, inline data" },
  { type: "table", label: "Table", hint: "Rows and columns, sortable" },
];

/** "+ Note" and a menu with the other widget types. */
export function AddMenu({ onAdd }: { onAdd: (type: WidgetType) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const add = (type: WidgetType) => {
    setOpen(false);
    onAdd(type);
  };

  return (
    <div className="add-menu" ref={root}>
      <button className="add-main" onClick={() => add("note")}>
        + Note
      </button>
      <button className="add-more" aria-label="Add another widget" aria-haspopup="menu" aria-expanded={open} title="Add a heading, metric, chart or table" onClick={() => setOpen((o) => !o)}>
        ▾
      </button>
      {open && (
        <div className="add-list" role="menu">
          {ITEMS.map((it) => (
            <button key={it.type} role="menuitem" onClick={() => add(it.type)}>
              <strong>{it.label}</strong>
              <span className="muted">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
