// Sandboxed rendering of html widgets.
//
// Widget HTML comes from peers, including agents, so it is untrusted:
// - it runs in <iframe sandbox="allow-scripts"> without allow-same-origin, so
//   it has an opaque origin and cannot read the app, its storage or the room key;
// - a CSP <meta> at the top of the document blocks all network access, except
//   for the origins the user allowed for this widget;
// - a small bridge script (`window.peerdash`) gives shared state and reports
//   errors, console output and size back to the host over postMessage.

import type { WidgetFeedback } from "@peerdash/core";

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

export function validOrigins(allow: string[]): string[] {
  return allow.map((o) => o.trim().replace(/\/+$/, "")).filter((o) => ORIGIN.test(o));
}

function csp(allow: string[]): string {
  const extra = validOrigins(allow).join(" ");
  const src = (base: string) => `${base} ${extra}`.trim();
  return [
    "default-src 'none'",
    `script-src ${src("'unsafe-inline' 'unsafe-eval'")}`,
    `style-src ${src("'unsafe-inline'")}`,
    `img-src ${src("data: blob:")}`,
    `font-src ${src("data:")}`,
    `media-src ${src("data: blob:")}`,
    `connect-src ${extra || "'none'"}`,
    // Map and chart libraries start workers from blob: URLs. Workers inherit
    // this policy, so they get no more network access than the widget.
    `worker-src ${src("blob:")}`,
  ].join("; ");
}

// Runs inside the iframe, before any widget code.
const BRIDGE = `(() => {
  const send = (m) => parent.postMessage(Object.assign({ __peerdash: true }, m), "*");
  let state = {};
  const subs = new Set();
  const notify = () => subs.forEach((f) => { try { f(state); } catch (e) { console.error(e); } });
  window.peerdash = {
    state: {
      get: (k) => (k === undefined ? Object.assign({}, state) : state[k]),
      set: (k, v) => { state = Object.assign({}, state, { [k]: v }); send({ type: "state:set", key: k, value: v }); notify(); },
      on: (f) => { subs.add(f); return () => subs.delete(f); },
    },
  };
  const report = () => send({ type: "size", width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || !e.data.__peerdash) return;
    if (e.data.type === "state") { state = e.data.state || {}; notify(); }
    if (e.data.type === "ping") { send({ type: "ready" }); report(); }
  });
  const fmt = (args) => args.map((x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch (_) { return String(x); } }).join(" ");
  for (const level of ["log", "info", "warn", "error"]) {
    const orig = console[level];
    console[level] = (...a) => { send({ type: level === "error" ? "error" : "log", text: fmt(a) }); orig.apply(console, a); };
  }
  addEventListener("error", (e) => send({ type: "error", text: e.message + (e.lineno ? " (line " + e.lineno + ")" : "") }));
  addEventListener("unhandledrejection", (e) => send({ type: "error", text: "Unhandled rejection: " + String(e.reason) }));
  addEventListener("securitypolicyviolation", (e) => send({ type: "error", text: "Blocked by sandbox: " + e.violatedDirective + " " + e.blockedURI }));
  // Report again shortly after load: the host may size the widget after the first paint.
  addEventListener("load", () => { report(); setTimeout(report, 400); setTimeout(report, 1500); new ResizeObserver(report).observe(document.documentElement); });
  send({ type: "ready" });
})();`;

const BASE_STYLE = `html,body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2933;background:#fff}body{padding:12px;box-sizing:border-box}@media (prefers-color-scheme:dark){html,body{color:#e4e7eb;background:#1c2128}}`;

export function buildSrcdoc(content: string, allow: string[]): string {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(allow)}"><script>${BRIDGE}</script>`;
  if (/<html[\s>]/i.test(content) || /<head[\s>]/i.test(content)) {
    // A full document: put our head first, before anything the widget declares.
    if (/<head[^>]*>/i.test(content)) return content.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
    return content.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!doctype html><html><head>${head}<style>${BASE_STYLE}</style></head><body>${content}</body></html>`;
}

// Feedback from the iframes this browser renders, published in presence.

type Listener = (all: Record<string, WidgetFeedback>) => void;

const MAX_LINES = 20;
const feedback: Record<string, WidgetFeedback> = {};
const listeners = new Set<Listener>();

function touch(id: string): WidgetFeedback {
  return (feedback[id] ??= { errors: [], logs: [], width: 0, height: 0, at: Date.now() });
}

export const frameFeedback = {
  reset(id: string) {
    feedback[id] = { errors: [], logs: [], width: 0, height: 0, at: Date.now() };
    this.emit();
  },
  add(id: string, kind: "error" | "log", text: string) {
    const f = touch(id);
    const list = kind === "error" ? f.errors : f.logs;
    list.push(text.slice(0, 500));
    if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES);
    f.at = Date.now();
    this.emit();
  },
  size(id: string, width: number, height: number) {
    const f = touch(id);
    if (f.width === width && f.height === height) return;
    f.width = width;
    f.height = height;
    f.at = Date.now();
    this.emit();
  },
  remove(id: string) {
    delete feedback[id];
    this.emit();
  },
  get: (id: string): WidgetFeedback | undefined => feedback[id],
  all: () => ({ ...feedback }),
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  emit() {
    const snapshot = { ...feedback };
    listeners.forEach((l) => l(snapshot));
  },
};
