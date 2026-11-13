// The `map` widget and the shared map context.
//
// A map is data, not code: a view, a basemap and a list of layers. The app
// renders it with MapLibre GL JS in a sandboxed iframe (see the web app's
// map.ts). A map makes each browser load URLs that a peer selected, so:
// - every URL (style, tiles) must be https, and its origin must be in the
//   widget's `allow` list. The renderer's CSP allows only these origins, so
//   the glyphs and sprites of a style must be on them too;
// - layers have a small style object, not MapLibre paint expressions;
// - GeoJSON is inline and size-limited.
//
// The default basemap is OpenFreeMap ("liberty" style). It needs no API key.
// Its style, tiles, glyphs and sprites are all on https://tiles.openfreemap.org.
// Core adds that origin to `allow` when a map uses the default basemap, so the
// allow list always shows every origin that the map loads from.

export type LngLat = [number, number];
/** [west, south, east, north], in degrees. */
export type BBox = [number, number, number, number];

export interface MapView {
  center?: LngLat;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  /** Fit the map to this box. Wins over center and zoom. */
  bbox?: BBox;
}

export interface MapStyle {
  /** A CSS colour: #rgb, #rrggbb, a name, or rgb()/hsl(). */
  color?: string;
  /** 0–1. */
  opacity?: number;
  /** Point radius in pixels, 1–40. */
  radius?: number;
  /** Line width in pixels, 0.5–20. */
  width?: number;
}

export interface GeoJsonLayer {
  id: string;
  type: "geojson";
  /** A FeatureCollection, a Feature or a geometry. */
  data: Record<string, unknown>;
  style?: MapStyle;
}
export interface RasterLayer {
  id: string;
  type: "raster";
  /** URL templates with {z}, {x}, {y}. */
  tiles: string[];
  tileSize?: number;
  opacity?: number;
  attribution?: string;
  minzoom?: number;
  maxzoom?: number;
}
export interface VectorLayer {
  id: string;
  type: "vector";
  /** URL templates of Mapbox Vector Tiles, with {z}, {x}, {y}. */
  tiles: string[];
  sourceLayer: string;
  geometry: "fill" | "line" | "circle";
  style?: MapStyle;
  attribution?: string;
  minzoom?: number;
  maxzoom?: number;
}
export type MapLayer = GeoJsonLayer | RasterLayer | VectorLayer;

export interface MapContent {
  view: MapView;
  /** "default" (OpenFreeMap), "none" (no basemap, no network), or the https URL of a MapLibre style. */
  basemap: string;
  layers: MapLayer[];
}

export const DEFAULT_BASEMAP = {
  style: "https://tiles.openfreemap.org/styles/liberty",
  origin: "https://tiles.openfreemap.org",
  attribution: "OpenFreeMap © OpenMapTiles, data from OpenStreetMap",
};

export const MAP_LIMITS = {
  /** Characters of the content as compact JSON. Inline GeoJSON counts. */
  content: 300_000,
  layers: 20,
  /** Features in one GeoJSON layer. */
  features: 5000,
  /** Positions in one GeoJSON layer. */
  positions: 100_000,
  tileUrls: 4,
  url: 500,
  geojsonDepth: 8,
};

export const MAP_SHAPE =
  'Shape: {"view": {"center": [13.4, 52.5], "zoom": 9} or {"bbox": [w, s, e, n]}, "basemap": "default" | "none" | "<https style URL>", "layers": [{"id": "sites", "type": "geojson", "data": {"type": "FeatureCollection", "features": [...]}, "style": {"color": "#d33", "radius": 5}}, {"id": "radar", "type": "raster", "tiles": ["https://host/{z}/{x}/{y}.png"], "opacity": 0.7}, {"id": "roads", "type": "vector", "tiles": ["https://host/{z}/{x}/{y}.pbf"], "sourceLayer": "roads", "geometry": "line"}]}. Every URL origin must be in allow. The default basemap adds https://tiles.openfreemap.org to allow.';

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

/** An https origin without a trailing slash, lower case; null if it is not one. */
export function cleanOrigin(o: string): string | null {
  const t = String(o).trim().replace(/\/+$/, "");
  return ORIGIN.test(t) ? t.toLowerCase() : null;
}

/** The https origins of an allow list, without the entries that are not origins. */
export function validOrigins(allow: readonly string[]): string[] {
  return [...new Set(allow.map(cleanOrigin).filter((o): o is string => o !== null))];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown, what: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a number.`);
  if (v < lo || v > hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
  return v;
}

const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

/** Check [lng, lat]. */
export function cleanLngLat(v: unknown, what = "lngLat"): LngLat {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${what} must be [longitude, latitude].`);
  return [round(num(v[0], `${what} longitude`, -180, 180)), round(num(v[1], `${what} latitude`, -90, 90))];
}

/** Check [west, south, east, north]. */
export function cleanBBox(v: unknown, what = "bbox"): BBox {
  if (!Array.isArray(v) || v.length !== 4) throw new Error(`${what} must be [west, south, east, north] in degrees.`);
  const [w, s, e, n] = v.map((x, i) => round(num(x, `${what}[${i}]`, i % 2 ? -90 : -180, i % 2 ? 90 : 180)));
  if (w >= e) throw new Error(`${what}: west (${w}) must be less than east (${e}).`);
  if (s >= n) throw new Error(`${what}: south (${s}) must be less than north (${n}).`);
  return [w, s, e, n];
}

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Check a datetime: an ISO 8601 date or date-time ("2026-05-01",
 * "2026-05-01T12:00:00Z"), or an interval "start/end" where ".." is an open end.
 */
export function cleanDatetime(v: unknown): string {
  if (typeof v !== "string") throw new Error("datetime must be text.");
  const t = v.trim();
  const one = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(s));
  const parts = t.split("/");
  const valid =
    parts.length === 1 ? one(t) : parts.length === 2 && parts.some((p) => p !== "..") && parts.every((p) => p === ".." || one(p));
  if (!valid) throw new Error(`Not a valid datetime: "${t.slice(0, 60)}". Use ISO 8601, e.g. "2026-05-01", "2026-05-01T12:00:00Z" or "2026-05-01/2026-05-31".`);
  if (parts.length === 2 && parts[0] !== ".." && parts[1] !== ".." && Date.parse(parts[0]) > Date.parse(parts[1])) {
    throw new Error("datetime: the start of the interval is after the end.");
  }
  return t;
}

const COLOUR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]{1,60}\))$/i;
const LAYER_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PLACEHOLDER = /\{([^}]*)\}/g;
const PLACEHOLDERS = new Set(["z", "x", "y", "quadkey", "bbox-epsg-3857", "ratio", "prefix"]);

function cleanStyle(v: unknown, where: string): MapStyle | undefined {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) throw new Error(`${where}.style must be an object: {"color", "opacity", "radius", "width"}.`);
  const out: MapStyle = {};
  for (const k of Object.keys(v)) if (!["color", "opacity", "radius", "width"].includes(k)) throw new Error(`${where}.style has an unknown key "${k}". Use color, opacity, radius, width.`);
  if (v.color !== undefined) {
    if (typeof v.color !== "string" || !COLOUR.test(v.color.trim())) throw new Error(`${where}.style.color must be a CSS colour, e.g. "#d33" or "teal".`);
    out.color = v.color.trim();
  }
  if (v.opacity !== undefined) out.opacity = num(v.opacity, `${where}.style.opacity`, 0, 1);
  if (v.radius !== undefined) out.radius = num(v.radius, `${where}.style.radius`, 1, 40);
  if (v.width !== undefined) out.width = num(v.width, `${where}.style.width`, 0.5, 20);
  return out;
}

/** Check one https URL (or URL template) and that its origin is allowed. */
function checkUrl(v: unknown, where: string, allowed: Set<string>, template: boolean): string {
  if (typeof v !== "string") throw new Error(`${where} must be a URL.`);
  const u = v.trim();
  if (u.length > MAP_LIMITS.url) throw new Error(`${where} is longer than ${MAP_LIMITS.url} characters.`);
  if (!/^https:\/\//i.test(u)) throw new Error(`${where} must start with https:// ("${u.slice(0, 80)}").`);
  let bare = u;
  if (template) {
    bare = u.replace(PLACEHOLDER, (_, name: string) => {
      if (!PLACEHOLDERS.has(name)) throw new Error(`${where} has an unknown placeholder {${name}}. Use {z}, {x}, {y}, {quadkey} or {bbox-epsg-3857}.`);
      return "0";
    });
  }
  let url: URL;
  try {
    url = new URL(bare);
  } catch {
    throw new Error(`${where} is not a valid URL ("${u.slice(0, 80)}").`);
  }
  if (url.username || url.password) throw new Error(`${where} must not contain a user name or password.`);
  if (!allowed.has(url.origin)) {
    throw new Error(`${where} loads from ${url.origin}, which is not in this widget's allow list. Add "${url.origin}" to allow, or use another source.`);
  }
  return u;
}

function cleanTiles(v: unknown, where: string, allowed: Set<string>): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${where}.tiles must be an array of URL templates, e.g. ["https://host/{z}/{x}/{y}.png"].`);
  if (v.length > MAP_LIMITS.tileUrls) throw new Error(`${where}.tiles can have at most ${MAP_LIMITS.tileUrls} URLs.`);
  return v.map((t, i) => checkUrl(t, `${where}.tiles[${i}]`, allowed, true));
}

function plainText(v: unknown, what: string, max: number): string {
  if (typeof v !== "string") throw new Error(`${what} must be text.`);
  // Attribution shows as text; drop markup.
  return v.replace(/[<>]/g, "").trim().slice(0, max);
}

const GEOMETRIES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"]);

/** Count features and positions, and check the GeoJSON shape. */
function checkGeoJson(v: unknown, where: string): void {
  let features = 0;
  let positions = 0;
  const coords = (c: unknown, depth: number): void => {
    if (!Array.isArray(c)) throw new Error(`${where}: coordinates must be arrays of numbers.`);
    if (depth > MAP_LIMITS.geojsonDepth) throw new Error(`${where}: coordinates are nested too deeply.`);
    if (c.length > 0 && !Array.isArray(c[0])) {
      if (c.length < 2 || c.length > 3 || !c.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error(`${where}: a position must be [longitude, latitude].`);
      if (++positions > MAP_LIMITS.positions) throw new Error(`${where} has more than ${MAP_LIMITS.positions} positions. Simplify the geometry first.`);
      return;
    }
    for (const x of c) coords(x, depth + 1);
  };
  const geometry = (g: unknown): void => {
    if (g === null) return;
    if (!isPlainObject(g) || !GEOMETRIES.has(g.type as string)) throw new Error(`${where}: a geometry needs a type: ${[...GEOMETRIES].join(", ")}.`);
    if (g.type === "GeometryCollection") {
      if (!Array.isArray(g.geometries)) throw new Error(`${where}: a GeometryCollection needs geometries.`);
      g.geometries.forEach(geometry);
    } else coords(g.coordinates, 0);
  };
  const feature = (f: unknown): void => {
    if (!isPlainObject(f) || f.type !== "Feature") throw new Error(`${where}: each item of features must be a Feature.`);
    if (++features > MAP_LIMITS.features) throw new Error(`${where} has more than ${MAP_LIMITS.features} features. Aggregate or filter the data first.`);
    if (f.properties !== undefined && f.properties !== null && !isPlainObject(f.properties)) throw new Error(`${where}: feature properties must be an object.`);
    geometry(f.geometry);
  };
  if (!isPlainObject(v)) throw new Error(`${where}.data must be GeoJSON: a FeatureCollection, a Feature or a geometry.`);
  if (v.type === "FeatureCollection") {
    if (!Array.isArray(v.features)) throw new Error(`${where}: a FeatureCollection needs features.`);
    v.features.forEach(feature);
  } else if (v.type === "Feature") feature(v);
  else geometry(v);
}

function zoomRange(v: unknown, what: string): number | undefined {
  return v === undefined ? undefined : num(v, what, 0, 24);
}

function cleanLayer(v: unknown, i: number, allowed: Set<string>): MapLayer {
  const where = `layers[${i}]`;
  if (!isPlainObject(v)) throw new Error(`${where} must be an object.`);
  if (typeof v.id !== "string" || !LAYER_ID.test(v.id)) throw new Error(`${where}.id must be 1-40 letters, digits, - or _.`);
  const id = v.id;
  const at = `layer "${id}"`;
  const extras = () => ({
    ...(v.attribution !== undefined && { attribution: plainText(v.attribution, `${at}.attribution`, 200) }),
    ...(v.minzoom !== undefined && { minzoom: zoomRange(v.minzoom, `${at}.minzoom`) }),
    ...(v.maxzoom !== undefined && { maxzoom: zoomRange(v.maxzoom, `${at}.maxzoom`) }),
  });
  switch (v.type) {
    case "geojson": {
      checkGeoJson(v.data, at);
      const style = cleanStyle(v.style, at);
      return { id, type: "geojson", data: v.data as Record<string, unknown>, ...(style && { style }) };
    }
    case "raster": {
      const out: RasterLayer = { id, type: "raster", tiles: cleanTiles(v.tiles, at, allowed), ...extras() };
      if (v.tileSize !== undefined) {
        if (v.tileSize !== 256 && v.tileSize !== 512) throw new Error(`${at}.tileSize must be 256 or 512.`);
        out.tileSize = v.tileSize;
      }
      if (v.opacity !== undefined) out.opacity = num(v.opacity, `${at}.opacity`, 0, 1);
      return out;
    }
    case "vector": {
      if (typeof v.sourceLayer !== "string" || !v.sourceLayer.trim() || v.sourceLayer.length > 100) throw new Error(`${at}.sourceLayer must name a layer in the vector tiles.`);
      if (v.geometry !== "fill" && v.geometry !== "line" && v.geometry !== "circle") throw new Error(`${at}.geometry must be "fill", "line" or "circle".`);
      const style = cleanStyle(v.style, at);
      return { id, type: "vector", tiles: cleanTiles(v.tiles, at, allowed), sourceLayer: v.sourceLayer.trim(), geometry: v.geometry, ...(style && { style }), ...extras() };
    }
    default:
      throw new Error(`${at}.type must be "geojson", "raster" or "vector".`);
  }
}

function cleanView(v: unknown): MapView {
  if (v === undefined) return { center: [0, 20], zoom: 1 };
  if (!isPlainObject(v)) throw new Error('view must be {"center": [lng, lat], "zoom": n} or {"bbox": [w, s, e, n]}.');
  for (const k of Object.keys(v)) if (!["center", "zoom", "bearing", "pitch", "bbox"].includes(k)) throw new Error(`view has an unknown key "${k}". Use center, zoom, bearing, pitch or bbox.`);
  const out: MapView = {};
  if (v.bbox !== undefined) out.bbox = cleanBBox(v.bbox, "view.bbox");
  if (v.center !== undefined) out.center = cleanLngLat(v.center, "view.center");
  if (v.zoom !== undefined) out.zoom = num(v.zoom, "view.zoom", 0, 22);
  if (v.bearing !== undefined) out.bearing = num(v.bearing, "view.bearing", -360, 360);
  if (v.pitch !== undefined) out.pitch = num(v.pitch, "view.pitch", 0, 85);
  if (!out.bbox && !out.center) throw new Error('view needs "center" (with "zoom") or "bbox".');
  return out;
}

/**
 * Check map content against an allow list. Returns the clean content.
 * Throws an error that says what is wrong.
 */
export function cleanMap(d: Record<string, unknown>, allow: readonly string[]): MapContent {
  const size = JSON.stringify(d).length;
  if (size > MAP_LIMITS.content) throw new Error(`The map is too large (${size} characters, at most ${MAP_LIMITS.content}). Simplify or filter the GeoJSON first.`);
  for (const k of Object.keys(d)) if (!["view", "basemap", "layers"].includes(k)) throw new Error(`A map has an unknown key "${k}". Use view, basemap and layers.`);
  const allowed = new Set(validOrigins(allow));
  let basemap = "default";
  if (d.basemap !== undefined) {
    if (typeof d.basemap !== "string") throw new Error('basemap must be "default", "none" or the https URL of a MapLibre style.');
    basemap = d.basemap.trim();
  }
  if (basemap === "default") {
    if (!allowed.has(DEFAULT_BASEMAP.origin)) throw new Error(`The default basemap loads from ${DEFAULT_BASEMAP.origin}, which is not in this widget's allow list. Add it, or set "basemap": "none".`);
  } else if (basemap !== "none") checkUrl(basemap, "basemap", allowed, false);
  const layers = d.layers === undefined ? [] : d.layers;
  if (!Array.isArray(layers)) throw new Error("layers must be an array.");
  if (layers.length > MAP_LIMITS.layers) throw new Error(`A map can have at most ${MAP_LIMITS.layers} layers.`);
  const clean = layers.map((l, i) => cleanLayer(l, i, allowed));
  const ids = new Set<string>();
  for (const l of clean) {
    if (ids.has(l.id)) throw new Error(`Two layers have the id "${l.id}". Layer ids must be unique.`);
    ids.add(l.id);
  }
  return { view: cleanView(d.view), basemap, layers: clean };
}

/**
 * The allow list that a map needs with this content: the default basemap adds
 * its origin. Content that is not valid JSON returns the list as it is.
 */
export function allowForMap(content: unknown, allow: readonly string[]): string[] {
  let d = content;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return [...allow];
    }
  }
  const basemap = isPlainObject(d) ? (d.basemap ?? "default") : null;
  if (basemap === "default" && !validOrigins(allow).includes(DEFAULT_BASEMAP.origin)) return [...allow, DEFAULT_BASEMAP.origin];
  return [...allow];
}

/**
 * A merge patch for map content. `layers` can be an object keyed by layer id:
 * `{"layers": {"sites": {...}}}` adds or merges the layer "sites", and
 * `{"layers": {"sites": null}}` removes it. Other layers keep their order.
 * An array replaces all layers.
 */
export function keyedLayers(current: MapContent, patch: Record<string, unknown>, merge: (t: unknown, p: unknown) => unknown): Record<string, unknown> {
  if (!isPlainObject(patch.layers)) return patch;
  const byId = new Map(current.layers.map((l) => [l.id, l as unknown]));
  for (const [id, p] of Object.entries(patch.layers)) {
    if (p === null) byId.delete(id);
    else byId.set(id, { ...(merge(byId.get(id), p) as Record<string, unknown>), id });
  }
  return { ...patch, layers: [...byId.values()] };
}

/** One short line, e.g. `map, 2 layers (geojson sites 12 features, raster radar), centre 13.4,52.5 zoom 9`. */
export function summariseMap(m: MapContent): string {
  const layers = m.layers.map((l) => {
    if (l.type !== "geojson") return `${l.type} ${l.id}`;
    const fc = l.data;
    const n = fc.type === "FeatureCollection" && Array.isArray(fc.features) ? fc.features.length : 1;
    return `geojson ${l.id} ${n} feature${n === 1 ? "" : "s"}`;
  });
  const v = m.view;
  const view = v.bbox ? `bbox ${v.bbox.join(",")}` : `centre ${v.center!.map((x) => round(x, 3)).join(",")} zoom ${v.zoom ?? 2}`;
  const basemap = m.basemap === "default" ? "" : m.basemap === "none" ? ", no basemap" : ", own basemap";
  return `map, ${m.layers.length} layer${m.layers.length === 1 ? "" : "s"}${layers.length ? ` (${layers.join(", ")})` : ""}, ${view}${basemap}`;
}

// Shared map context ---------------------------------------------------------

/** The map extent and time that the dashboard shares. Linked widgets follow it. */
export interface MapContext {
  bbox?: BBox;
  /** ISO 8601 date, date-time or interval. */
  datetime?: string;
}

/** A person's map view, in presence. A type alias, so it counts as JSON for the transport. */
export type MapViewPresence = {
  bbox: BBox;
  center: LngLat;
  zoom: number;
};

/** Presence from another peer: keep a map view only when it is well formed. */
export function sanitiseMapView(v: unknown): MapViewPresence | undefined {
  if (!isPlainObject(v)) return undefined;
  try {
    // Map extents can cross the antimeridian or the poles: clamp, do not reject.
    const b = v.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((x) => typeof x === "number" && Number.isFinite(x))) return undefined;
    const c = (x: number, lim: number) => Math.min(lim, Math.max(-lim, x));
    const bbox: BBox = [c(b[0], 180), c(b[1], 90), c(b[2], 180), c(b[3], 90)];
    return { bbox, center: cleanLngLat(v.center), zoom: num(v.zoom, "zoom", 0, 24) };
  } catch {
    return undefined;
  }
}
