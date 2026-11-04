import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { Widget } from "@peerdash/core";
import { HtmlFrame } from "./HtmlFrame";
import { useCanvas } from "./hooks";

export type WidgetNodeData = { widget: Widget };

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || "*Empty note — double-click to write.*", { async: false })), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function NoteEditor({ widget, onDone }: { widget: Widget; onDone: () => void }) {
  const { doc, author } = useCanvas();
  const [text, setText] = useState(widget.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => {
    if (text !== widget.content) doc.updateWidget(widget.id, { content: text }, author);
    onDone();
  };
  return (
    <textarea
      ref={ref}
      className="note-editor nodrag nowheel"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) save();
      }}
    />
  );
}

function WidgetNodeView({ id, data, selected }: NodeProps & { data: WidgetNodeData }) {
  const { doc, author, remoteSelection } = useCanvas();
  const w = data.widget;
  const [editing, setEditing] = useState(false);
  const peers = remoteSelection.get(id) ?? [];
  const openComments = doc.comments(id).filter((c) => !c.resolved).length;
  const ring = peers[0]?.colour;

  return (
    <div className={`widget widget-${w.type}${selected ? " is-selected" : ""}`} style={ring ? { outline: `2px solid ${ring}`, outlineOffset: 2 } : undefined}>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={60}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_, p) => doc.moveWidgets([{ id, x: p.x, y: p.y, w: p.width, h: p.height }], author)}
      />
      <Handle type="target" position={Position.Left} />
      <div className="widget-header">
        <span className="widget-kind">{w.type === "html" ? "HTML" : "Note"}</span>
        <span className="widget-title">{w.title || (w.type === "html" ? "Untitled widget" : "")}</span>
        {openComments > 0 && (
          <span className="comment-badge" title={`${openComments} open comment${openComments === 1 ? "" : "s"}`}>
            💬 {openComments}
          </span>
        )}
        {peers.length > 0 && (
          <span className="widget-peers">
            {peers.map((p) => (
              <span key={p.id} className="peer-tag" style={{ background: p.colour }} title={p.activity ?? undefined}>
                {p.kind === "agent" ? "✦ " : ""}
                {p.name || "Guest"}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="widget-body" onDoubleClick={() => w.type === "note" && setEditing(true)}>
        {w.type === "html" ? (
          <HtmlFrame id={id} content={w.content} allow={w.allow} />
        ) : editing ? (
          <NoteEditor widget={w} onDone={() => setEditing(false)} />
        ) : (
          <Markdown text={w.content} />
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const WidgetNode = memo(WidgetNodeView);
