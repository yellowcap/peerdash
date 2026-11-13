declare module "virtual:chart-runtime" {
  /** Vega, Vega-Lite, vega-embed and the expression interpreter, as one classic script. See vite.config.ts. */
  const code: string;
  export default code;
}

declare module "virtual:map-runtime" {
  /** MapLibre GL JS as a classic script. See vite.config.ts. */
  export const js: string;
  /** The MapLibre GL JS stylesheet. */
  export const css: string;
}
