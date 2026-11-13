import type { Layout } from "@peerdash/core";

/** The layouts a user can pick now. Grid and map come later. */
export const LAYOUT_OPTIONS: { value: Layout; label: string; ready: boolean }[] = [
  { value: "canvas", label: "Canvas", ready: true },
  { value: "page", label: "Page", ready: true },
  { value: "grid", label: "Grid (later)", ready: false },
  { value: "map", label: "Map (later)", ready: false },
];

export function LayoutSelect({
  value,
  onChange,
  title = "Layout. A change keeps every widget.",
}: {
  value: Layout;
  onChange: (l: Layout) => void;
  title?: string;
}) {
  return (
    <select className="layout-select" value={value} aria-label="Layout" title={title} onChange={(e) => onChange(e.target.value as Layout)}>
      {LAYOUT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value} disabled={!o.ready}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
