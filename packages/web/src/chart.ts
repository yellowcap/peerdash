// Sandboxed rendering of chart widgets.
//
// A chart spec comes from peers, so it is untrusted. Vega compiles
// expressions in a spec ("calculate", "filter", signals) to JavaScript, and
// Vega has had bugs that let an expression run any code (for example
// CVE-2025-25304 and CVE-2025-27793). In the app's own origin, such code could
// read the room keys in local storage. So charts do not render in the app:
// - they render in <iframe sandbox="allow-scripts"> without allow-same-origin,
//   as html widgets do, so the iframe has an opaque origin;
// - the CSP allows only inline scripts and styles, and data: and blob: images.
//   There is no connect-src, so the chart cannot load or send anything;
// - Vega runs with the expression interpreter (`ast: true`), not with
//   `new Function`, so the CSP also blocks eval;
// - the Vega loader rejects every load, and core rejects specs with URLs.
//
// The renderer is not on the network either: the iframe gets it inline, from
// a lazily loaded chunk of the app.

import type { MapContext } from "@peerdash/core";

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
].join("; ");

// Runs inside the iframe, after the renderer.
const BOOT = `(() => {
  const send = (m) => parent.postMessage(Object.assign({ __peerdash: true }, m), "*");
  // A container-sized chart can trigger this harmless browser warning.
  addEventListener("error", (e) => /^ResizeObserver loop/.test(e.message) || send({ type: "error", text: e.message }));
  addEventListener("unhandledrejection", (e) => send({ type: "error", text: String(e.reason && e.reason.message || e.reason) }));
  addEventListener("securitypolicyviolation", (e) => send({ type: "error", text: "Blocked by sandbox: " + e.violatedDirective + " " + e.blockedURI }));
  const loader = vega.loader();
  const no = () => Promise.reject(new Error("Charts can use only inline data."));
  loader.load = no; loader.sanitize = no; loader.http = no; loader.file = no;
  const el = document.getElementById("chart");
  const report = () => { const d = document.documentElement; send({ type: "size", width: d.scrollWidth, height: d.scrollHeight, contentHeight: Math.ceil(el.getBoundingClientRect().height) }); };
  let view = null;
  let n = 0;
  addEventListener("message", async (e) => {
    if (e.source !== parent || !e.data || !e.data.__peerdash || e.data.type !== "chart") return;
    const run = ++n;
    document.body.className = e.data.fill ? "fill" : "";
    try {
      const res = await vegaEmbed(el, e.data.spec, {
        mode: "vega-lite", actions: false, renderer: "svg", ast: true, expr: self.vegaExpressionInterpreter,
        loader, theme: e.data.dark ? "dark" : undefined, config: { background: "transparent" },
      });
      if (run !== n) { res.finalize(); return; }
      if (view) view.finalize();
      view = res;
      send({ type: "rendered" });
    } catch (err) {
      el.textContent = "";
      send({ type: "error", text: String(err && err.message || err) });
    }
    report();
  });
  new ResizeObserver(report).observe(el);
  send({ type: "ready" });
})();`;

const STYLE = `html,body{margin:0;background:transparent;font:13px system-ui,-apple-system,"Segoe UI",sans-serif}html:has(body.fill),body.fill{height:100%}#chart{width:100%;box-sizing:border-box}body.fill #chart{height:100%}.vega-embed{width:100%;display:block}body.fill .vega-embed{height:100%}html,body{overflow:hidden}.vega-embed svg{display:block}`;

let srcdoc: Promise<string> | null = null;

/** The iframe document for charts. The same for all charts; the spec comes by postMessage. */
export function chartSrcdoc(): Promise<string> {
  srcdoc ??= import("virtual:chart-runtime").then(({ default: code }) => {
    const safe = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1");
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${STYLE}</style></head><body><div id="chart"></div><script>${safe(code)}</script><script>${BOOT}</script></body></html>`;
  });
  return srcdoc;
}

/**
 * A linked chart gets the shared map context as Vega-Lite params:
 * `context_bbox` ([west, south, east, north] or null) and `context_datetime`
 * (text or null). A spec uses them in expressions, for example
 * `{"filter": "context_bbox == null || datum.lon >= context_bbox[0]"}`.
 * Params of the spec with these names are replaced.
 */
export function withContext(spec: Record<string, unknown>, ctx: MapContext | null): Record<string, unknown> {
  if (!ctx) return spec;
  const own = Array.isArray(spec.params) ? (spec.params as { name?: unknown }[]).filter((p) => p?.name !== "context_bbox" && p?.name !== "context_datetime") : [];
  return { ...spec, params: [...own, { name: "context_bbox", value: ctx.bbox ?? null }, { name: "context_datetime", value: ctx.datetime ?? null }] };
}

/**
 * Size a single chart to its box when the spec sets no size. `fill`: the box
 * has a fixed height (canvas); else only the width follows the box (page).
 */
export function fitSpec(spec: Record<string, unknown>, fill: boolean): Record<string, unknown> {
  const single = spec.mark !== undefined || spec.layer !== undefined;
  if (!single) return spec;
  const out = { ...spec };
  if (out.width === undefined) out.width = "container";
  if (out.height === undefined) out.height = fill ? "container" : 260;
  if (out.autosize === undefined) out.autosize = { type: "fit", contains: "padding" };
  if (out.padding === undefined) out.padding = 10;
  return out;
}
