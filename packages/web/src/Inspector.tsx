import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { allowForMap, cleanContent, isTypedWidget, SHAPES, type Widget } from "@peerdash/core";
import { KIND_LABEL } from "./TypedWidgets";
import { frameFeedback, validOrigins } from "./frame";
import { useCanvas } from "./hooks";
import { Comments } from "./Comments";

/** Side panel to edit the selected widget: title, source, network access. */
export function Inspector({ widget, onClose }: { widget: Widget; onClose: () => void }) {
  const { doc, author } = useCanvas();
  const [title, setTitle] = useState(widget.title);
  const typed = isTypedWidget(widget.type);
  // Typed content is stored as compact JSON; edit it pretty-printed.
  const shown = useMemo(() => (typed ? pretty(widget.content) : widget.content), [typed, widget.content]);
  const [content, setContent] = useState(shown);
  const [allow, setAllow] = useState(widget.allow.join("\n"));
  const [saveError, setSaveError] = useState<string | null>(null);
  const networked = widget.type === "html" || widget.type === "map";
  const linkable = widget.type === "html" || widget.type === "chart" || widget.type === "map";
  const feedback = useSyncExternalStore(frameFeedback.subscribe, () => frameFeedback.get(widget.id));

  // Follow remote edits while the fields are untouched.
  useEffect(() => setTitle(widget.title), [widget.title]);
  useEffect(() => setContent(shown), [shown]);
  useEffect(() => setAllow(widget.allow.join("\n")), [widget.allow.join("\n")]);

  const invalid = useMemo(() => {
    if (!isTypedWidget(widget.type) || (content === shown && allow === widget.allow.join("\n"))) return null;
    try {
      const origins = validOrigins(allow.split(/[\s,]+/));
      cleanContent(widget.type, content, widget.type === "map" ? allowForMap(content, origins) : origins);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [widget.type, content, shown, allow, widget.allow]);
  const dirty = title !== widget.title || content !== shown || allow !== widget.allow.join("\n");
  const save = () => {
    const origins = validOrigins(allow.split(/[\s,]+/));
    // Only changed fields, so the change log says what really changed.
    try {
      doc.updateWidget(
        widget.id,
        {
          title: title !== widget.title ? title : undefined,
          content: content !== shown ? content : undefined,
          allow: origins.join("\n") !== widget.allow.join("\n") ? origins : undefined,
        },
        author,
      );
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <aside className="inspector">
      <header>
        <strong>{widget.type === "html" ? "HTML widget" : KIND_LABEL[widget.type]}</strong>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="grow">
        {widget.type === "html" ? "HTML" : typed ? "Content (JSON)" : "Markdown"}
        <textarea
          className={typed ? "code" : undefined}
          value={content}
          spellCheck={widget.type === "note"}
          aria-invalid={invalid ? true : undefined}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty && !invalid && save()}
        />
      </label>
      {typed && (invalid ? <div className="error json-error">{invalid}</div> : <div className="muted json-hint">{SHAPES[widget.type as keyof typeof SHAPES]}</div>)}
      {networked && (
        <label>
          Allowed network origins (one per line, https only){widget.type === "map" ? ". The map loads only from these." : ""}
          <textarea className="short" value={allow} placeholder="https://cdn.jsdelivr.net" onChange={(e) => setAllow(e.target.value)} />
        </label>
      )}
      {linkable && (
        <label className="check">
          <input type="checkbox" checked={widget.linked} onChange={(e) => doc.updateWidget(widget.id, { linked: e.target.checked }, author)} />
          Follow the shared map view and time
        </label>
      )}
      {saveError && <div className="error json-error">{saveError}</div>}
      <div className="row">
        <button className="primary" disabled={!dirty || !!invalid} onClick={save}>
          Save
        </button>
        <span className="muted">Added by {widget.createdBy || "unknown"}</span>
      </div>
      {(widget.type === "html" || widget.type === "chart" || widget.type === "map") && feedback && (feedback.errors.length > 0 || feedback.logs.length > 0) && (
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

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
