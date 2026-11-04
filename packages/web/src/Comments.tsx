import { useState } from "react";
import { MAX_COMMENT_LENGTH } from "@peerdash/core";
import { useCanvas, useDocVersion } from "./hooks";

function when(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** The comment thread of one widget. */
export function Comments({ widgetId }: { widgetId: string }) {
  const { doc, author } = useCanvas();
  useDocVersion(doc);
  const [text, setText] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const all = doc.comments(widgetId);
  const open = all.filter((c) => !c.resolved);
  const shown = showResolved ? all : open;

  const send = () => {
    if (!text.trim()) return;
    doc.addComment(widgetId, text, author);
    setText("");
  };

  return (
    <section className="comments">
      <header>
        <strong>Comments</strong>
        {all.length > open.length && (
          <button className="ghost small" onClick={() => setShowResolved((s) => !s)}>
            {showResolved ? "Hide resolved" : `Show resolved (${all.length - open.length})`}
          </button>
        )}
      </header>
      {shown.length === 0 && <p className="muted small">No comments yet.</p>}
      <ul>
        {shown.map((c) => (
          <li key={c.id} className={c.resolved ? "resolved" : undefined}>
            <div className="comment-meta">
              <strong>{c.author || "Guest"}</strong>
              <span className="muted">{when(c.createdAt)}</span>
              <span className="comment-actions">
                <button className="ghost small" onClick={() => doc.resolveComment(c.id, !c.resolved, author)}>
                  {c.resolved ? "Reopen" : "Resolve"}
                </button>
                {c.author === author && (
                  <button className="ghost small" onClick={() => doc.deleteComment(c.id, author)} aria-label="Delete comment">
                    ×
                  </button>
                )}
              </span>
            </div>
            <div className="comment-text">{c.text}</div>
          </li>
        ))}
      </ul>
      <textarea
        className="comment-input"
        value={text}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder="Add a comment… (Ctrl+Enter to send)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      <div className="row">
        <button className="primary" disabled={!text.trim()} onClick={send}>
          Comment
        </button>
      </div>
    </section>
  );
}
