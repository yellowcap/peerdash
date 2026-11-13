import { useEffect, useMemo, useRef } from "react";
import { buildSrcdoc, frameFeedback } from "./frame";
import { useCanvas, useDocVersion, useMapContext } from "./hooks";

/**
 * An html widget in a sandboxed iframe, with the state bridge wired to the
 * document. A linked widget also gets the shared map context.
 */
export function HtmlFrame({ id, content, allow, linked = false }: { id: string; content: string; allow: string[]; linked?: boolean }) {
  const { doc, author } = useCanvas();
  const ctx = useMapContext(doc);
  const context = linked ? ctx : null;
  const ref = useRef<HTMLIFrameElement>(null);
  const version = useDocVersion(doc);
  // Rebuild (and reload) the iframe only when its code changes, not on state changes.
  const srcdoc = useMemo(() => buildSrcdoc(content, allow), [content, allow.join(" ")]);

  useEffect(() => {
    frameFeedback.reset(id);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data?.__peerdash) return;
      const m = e.data;
      if (m.type === "ready") {
        post();
        postContext();
      }
      else if (m.type === "state:set" && typeof m.key === "string") doc.setWidgetState(id, m.key, m.value, author);
      else if (m.type === "error" || m.type === "log") frameFeedback.add(id, m.type, String(m.text));
      else if (m.type === "size") frameFeedback.size(id, Number(m.width) || 0, Number(m.height) || 0, Number(m.contentHeight) || 0);
    };
    const post = () => ref.current?.contentWindow?.postMessage({ __peerdash: true, type: "state", state: doc.widgetState(id) }, "*");
    const postContext = () => ref.current?.contentWindow?.postMessage({ __peerdash: true, type: "context", context: contextRef.current ?? {} }, "*");
    window.addEventListener("message", onMessage);
    // The iframe may have loaded before this listener: ask it to report again.
    ref.current?.contentWindow?.postMessage({ __peerdash: true, type: "ping" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [id, srcdoc, doc, author]);

  // Push shared state into the iframe whenever the document changes.
  const state = JSON.stringify(doc.widgetState(id));
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ __peerdash: true, type: "state", state: JSON.parse(state) }, "*");
  }, [state, version]);

  // The shared context, for a linked widget. An unlinked widget gets {}.
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ __peerdash: true, type: "context", context: context ?? {} }, "*");
  }, [context]);

  useEffect(() => () => frameFeedback.remove(id), [id]);

  return <iframe ref={ref} className="html-frame nodrag nowheel" title={id} sandbox="allow-scripts" srcDoc={srcdoc} />;
}
