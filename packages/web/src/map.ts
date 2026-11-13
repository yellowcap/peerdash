// Sandboxed rendering of map widgets.
//
// Where MapLibre runs: in a sandboxed iframe, not in the app. A map is data,
// but MapLibre loads URLs that a peer selected (style, tiles, and the glyphs
// and sprites that a style names), and it is a large parser of remote data.
// In the app's origin, a bug there could read the room keys in local storage,
// and only our own checks would limit which hosts the browser contacts. So:
// - the map renders in <iframe sandbox="allow-scripts"> without
//   allow-same-origin, so the iframe has an opaque origin;
// - the CSP allows network access (connect-src, img-src) only to the
//   origins in the widget's `allow` list. Core also rejects content with URLs
//   on other origins, so the agent gets a clear error first;
// - MapLibre's worker starts from a blob: URL and inherits the same CSP;
// - layer styles are a few numbers and colours, not MapLibre expressions;
// - feature properties show in popups as text, never as HTML.
//
// MapLibre is not on the network either: the iframe gets it inline, from a
// lazily loaded chunk of the app. The iframe document depends only on the
// allow list. Content, the context and marker positions come by postMessage.

import { validOrigins } from "@peerdash/core";

function csp(allow: readonly string[]): string {
  const origins = validOrigins(allow).join(" ");
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${origins}`.trim(),
    "font-src data:",
    `connect-src ${origins || "'none'"}`,
    "worker-src blob:",
    "child-src blob:",
  ].join("; ");
}

// Runs inside the iframe, after MapLibre.
const BOOT = `(() => {
  const send = (m) => parent.postMessage(Object.assign({ __peerdash: true }, m), "*");
  const seen = new Set();
  // One message per kind of error and host: a blocked tile source fails for every tile.
  const error = (text) => {
    text = String(text).slice(0, 300);
    const key = text.replace(/(https?:\\/\\/[^\\/\\s]+)\\S*/g, "$1");
    if (seen.has(key) || seen.size > 30) return;
    seen.add(key);
    send({ type: "error", text });
  };
  addEventListener("error", (e) => /^ResizeObserver loop/.test(e.message) || error(e.message));
  addEventListener("unhandledrejection", (e) => error(e.reason && e.reason.message || e.reason));
  addEventListener("securitypolicyviolation", (e) => error("Blocked by sandbox: " + e.violatedDirective + " " + e.blockedURI));

  const PALETTE = ["#2f6690", "#c0392b", "#5a7d2a", "#7b4f9d", "#a07a00", "#1f7a74"];
  let map = null, cur = null, styleKey = null, layersKey = null, viewKey = null, followKey = null;
  let markers = {}, peers = [], dark = false, userMove = false, frame = 0;

  const blank = () => ({ version: 8, sources: {}, layers: [{ id: "pd-bg", type: "background", paint: { "background-color": dark ? "#1c2128" : "#e9eef2" } }] });
  const styleOf = (m) => m.basemapUrl || blank();
  const bounds = (b) => [[b[0], b[1]], [b[2], b[3]]];

  function viewOptions(v) {
    if (v.bbox) return { bounds: bounds(v.bbox), fitBoundsOptions: { padding: 20 } };
    return { center: v.center, zoom: v.zoom === undefined ? 2 : v.zoom, bearing: v.bearing || 0, pitch: v.pitch || 0 };
  }
  function applyView(v, duration) {
    if (v.bbox) map.fitBounds(bounds(v.bbox), { padding: 20, duration });
    else map.easeTo({ center: v.center, zoom: v.zoom === undefined ? 2 : v.zoom, bearing: v.bearing || 0, pitch: v.pitch || 0, duration });
  }

  const ours = () => (map.getStyle().layers || []).map((l) => l.id).filter((id) => id.startsWith("pd-") && id !== "pd-bg");
  const clickable = [];

  function addLayers() {
    for (const id of ours()) map.removeLayer(id);
    for (const s of Object.keys(map.getStyle().sources || {})) if (s.startsWith("pd-")) map.removeSource(s);
    clickable.length = 0;
    cur.content.layers.forEach((l, i) => {
      const src = "pd-" + l.id;
      const st = l.style || {};
      const color = st.color || PALETTE[i % PALETTE.length];
      const opacity = st.opacity === undefined ? 1 : st.opacity;
      const zoom = {};
      if (l.minzoom !== undefined) zoom.minzoom = l.minzoom;
      if (l.maxzoom !== undefined) zoom.maxzoom = l.maxzoom;
      if (l.type === "raster") {
        map.addSource(src, Object.assign({ type: "raster", tiles: l.tiles, tileSize: l.tileSize || 256, attribution: l.attribution || "" }, zoom));
        map.addLayer({ id: src + "-raster", type: "raster", source: src, paint: { "raster-opacity": l.opacity === undefined ? 1 : l.opacity } });
        return;
      }
      if (l.type === "geojson") map.addSource(src, { type: "geojson", data: l.data });
      else map.addSource(src, Object.assign({ type: "vector", tiles: l.tiles, attribution: l.attribution || "" }, zoom));
      const base = l.type === "vector" ? { source: src, "source-layer": l.sourceLayer } : { source: src };
      const is = (types) => ["in", ["geometry-type"], ["literal", types]];
      const kinds = l.type === "vector" ? [l.geometry] : ["fill", "line", "circle"];
      for (const k of kinds) {
        const id = src + "-" + k;
        const filter = l.type === "vector" ? undefined : k === "fill" ? is(["Polygon", "MultiPolygon"]) : k === "line" ? is(["LineString", "MultiLineString", "Polygon", "MultiPolygon"]) : is(["Point", "MultiPoint"]);
        const paint =
          k === "fill" ? { "fill-color": color, "fill-opacity": opacity * 0.35 } :
          k === "line" ? { "line-color": color, "line-opacity": opacity, "line-width": st.width || 2 } :
          { "circle-color": color, "circle-opacity": opacity, "circle-radius": st.radius || 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1 };
        map.addLayer(Object.assign({ id, type: k, paint }, base, filter ? { filter } : {}));
        clickable.push(id);
      }
    });
    drawPeers();
  }

  function drawPeers() {
    if (!map.isStyleLoaded()) return;
    const data = { type: "FeatureCollection", features: peers.map((p) => ({ type: "Feature", properties: { colour: p.colour }, geometry: { type: "Polygon", coordinates: [[[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[1]], [p.bbox[2], p.bbox[3]], [p.bbox[0], p.bbox[3]], [p.bbox[0], p.bbox[1]]]] } })) };
    const s = map.getSource("pd-peers");
    if (s) { s.setData(data); return; }
    map.addSource("pd-peers", { type: "geojson", data });
    map.addLayer({ id: "pd-peers-line", type: "line", source: "pd-peers", paint: { "line-color": ["get", "colour"], "line-width": 2, "line-dasharray": [2, 2] } });
  }

  function project() {
    frame = 0;
    if (!map) return;
    const points = {};
    for (const id in markers) { const p = map.project(markers[id]); points[id] = [Math.round(p.x), Math.round(p.y)]; }
    send({ type: "points", points });
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(project); };

  function view(user) {
    const c = map.getCenter(), b = map.getBounds();
    send({ type: "view", user, center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] });
  }

  function popup(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    const props = Object.entries(f.properties || {}).slice(0, 20);
    if (!props.length) return;
    const t = document.createElement("table");
    for (const [k, v] of props) {
      const tr = t.insertRow();
      tr.insertCell().textContent = k;
      tr.insertCell().textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    new maplibregl.Popup({ maxWidth: "260px" }).setLngLat(e.lngLat).setDOMContent(t).addTo(map);
  }

  function create(m) {
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) { error("This browser cannot show maps: WebGL is not available. Turn on hardware acceleration, or use another browser."); return; }
    const start = m.follow ? { bounds: bounds(m.follow), fitBoundsOptions: { padding: 20 } } : viewOptions(m.content.view);
    map = new maplibregl.Map(Object.assign({ container: "map", style: styleOf(m), attributionControl: { compact: true }, interactive: m.interactive !== false }, start));
    if (m.interactive !== false) map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.on("error", (e) => error(e.error && e.error.message || "Map error"));
    map.on("style.load", () => { addLayers(); send({ type: "rendered" }); });
    map.on("movestart", (e) => { if (e.originalEvent) userMove = true; });
    map.on("move", schedule);
    map.on("moveend", (e) => { const user = userMove || !!e.originalEvent; userMove = false; view(user); schedule(); });
    map.on("click", (e) => {
      const hits = clickable.length ? map.queryRenderedFeatures(e.point, { layers: clickable.filter((id) => map.getLayer(id)) }) : [];
      if (hits.length) popup({ features: hits, lngLat: e.lngLat });
      send({ type: "click", lngLat: [e.lngLat.lng, e.lngLat.lat] });
    });
    map.once("load", () => { view(false); schedule(); });
    new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  }

  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || !e.data.__peerdash) return;
    const m = e.data;
    try {
      if (m.type === "map") {
        dark = !!m.dark;
        markers = m.markers || {};
        const sKey = JSON.stringify([m.basemapUrl || null, m.basemapUrl ? null : dark]);
        const lKey = JSON.stringify(m.content.layers);
        const vKey = JSON.stringify(m.content.view);
        const fKey = JSON.stringify([m.follow || null, m.refit || 0]);
        cur = m;
        if (!map) { if (styleKey !== null) return; create(m); styleKey = sKey; layersKey = lKey; viewKey = vKey; followKey = fKey; return; }
        if (sKey !== styleKey) { styleKey = sKey; layersKey = lKey; map.setStyle(styleOf(m)); }
        else if (lKey !== layersKey && map.isStyleLoaded()) { layersKey = lKey; addLayers(); }
        else if (lKey !== layersKey) { layersKey = lKey; map.once("idle", addLayers); }
        if (vKey !== viewKey) { viewKey = vKey; applyView(m.content.view, 500); }
        if (fKey !== followKey) { followKey = fKey; if (m.follow) map.fitBounds(bounds(m.follow), { padding: 20, duration: 600 }); }
        schedule();
      } else if (m.type === "peers" && map) {
        peers = m.peers || [];
        drawPeers();
      } else if (m.type === "unproject" && map) {
        const ll = map.unproject([m.x, m.y]);
        send({ type: "unprojected", req: m.req, lngLat: [ll.lng, ll.lat] });
      }
    } catch (err) {
      error(err && err.message || err);
    }
  });
  send({ type: "ready" });
})();`;

const STYLE = `html,body,#map{margin:0;height:100%;width:100%;overflow:hidden;background:transparent;font:12px system-ui,-apple-system,"Segoe UI",sans-serif}.maplibregl-popup-content table{border-collapse:collapse}.maplibregl-popup-content td{padding:1px 6px 1px 0;vertical-align:top}.maplibregl-popup-content td:first-child{color:#667;}`;

let runtime: Promise<{ js: string; css: string }> | null = null;

/** The iframe document for a map with this allow list. */
export async function mapSrcdoc(allow: readonly string[]): Promise<string> {
  runtime ??= import("virtual:map-runtime");
  const { js, css } = await runtime;
  const safe = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(allow)}"><style>${safe(css)}${STYLE}</style></head><body><div id="map"></div><script>${safe(js)}</script><script>${BOOT}</script></body></html>`;
}
