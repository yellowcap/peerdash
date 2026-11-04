import { useEffect, useState, useSyncExternalStore } from "react";
import type { Widget } from "@peerdash/core";
import { frameFeedback, validOrigins } from "./frame";
import { useCanvas } from "./hooks";
import { Comments } from "./Comments";

/** Side panel to edit the selected widget: title, source, network access. */
export function Inspector({ widget, onClose }: { widget: Widget; onClose: () => void }) {
  const { doc, author } = useCanvas();
  const [title, setTitle] = useState(widget.title);
  const [content, setContent] = useState(widget.content);
  const [allow, setAllow] = useState(widget.allow.join("\n"));
  const feedback = useSyncExternalStore(frameFeedback.subscribe, () => frameFeedback.get(widget.id));

  // Follow remote edits while the fields are untouched.
  useEffect(() => setTitle(widget.title), [widget.title]);
  useEffect(() => setContent(widget.content), [widget.content]);
  useEffect(() => setAllow(widget.allow.join("\n")), [widget.allow.join("\n")]);

  const dirty = title !== widget.title || content !== widget.content || allow !== widget.allow.join("\n");
  const save = () => {
    const origins = validOrigins(allow.split(/[\s,]+/));
    // Only changed fields, so the change log says what really changed.
    doc.updateWidget(
      widget.id,
      {
        title: title !== widget.title ? title : undefined,
        content: content !== widget.content ? content : undefined,
        allow: origins.join("\n") !== widget.allow.join("\n") ? origins : undefined,
      },
      author,
    );
  };

  return (
    <aside className="inspector">
      <header>
        <strong>{widget.type === "html" ? "HTML widget" : "Note"}</strong>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="grow">
        {widget.type === "html" ? "HTML" : "Markdown"}
        <textarea value={content} spellCheck={widget.type === "note"} onChange={(e) => setContent(e.target.value)} />
      </label>
      {widget.type === "html" && (
        <label>
          Allowed network origins (one per line, https only)
          <textarea className="short" value={allow} placeholder="https://cdn.jsdelivr.net" onChange={(e) => setAllow(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
        <span className="muted">Added by {widget.createdBy || "unknown"}</span>
      </div>
      {widget.type === "html" && feedback && (feedback.errors.length > 0 || feedback.logs.length > 0) && (
        <div className="feedback">
          {feedback.errors.map((e, i) => (
            <div key={`e${i}`} className="error">
              {e}
            </div>
          ))}
          {feedback.logs.slice(-5).map((l, i) => (
            <div key={`l${i}`}>{l}</div>
          ))}
        </div>
      )}
      <Comments widgetId={widget.id} />
    </aside>
  );
}
