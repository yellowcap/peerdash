import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

const RUNTIME = "virtual:chart-runtime";

/**
 * The chart renderer (Vega, Vega-Lite, vega-embed and the Vega expression
 * interpreter) as one classic script, in a text module. Chart iframes inline
 * it, so they need no network access. The app imports it lazily, so it is a
 * separate chunk and is loaded only when a dashboard has a chart.
 */
function chartRuntime(): Plugin {
  const file = (p: string) => readFileSync(fileURLToPath(new URL(`node_modules/${p}`, import.meta.url)), "utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, "");
  return {
    name: "peerdash-chart-runtime",
    resolveId: (id) => (id === RUNTIME ? `\0${RUNTIME}` : null),
    load(id) {
      if (id !== `\0${RUNTIME}`) return null;
      // vega-interpreter is ESM only. Its imports are in the Vega global.
      const interpreter = file("vega-interpreter/build/vega-interpreter.js")
        .replace(/^import \{([^}]+)\} from 'vega-util';$/m, "const {$1} = self.vega;")
        .replace(/^export \{ expression as expressionInterpreter \};$/m, "self.vegaExpressionInterpreter = expression;");
      if (interpreter.includes("import ") && /^import /m.test(interpreter)) throw new Error("vega-interpreter has new imports: update vite.config.ts");
      const code = [
        file("vega/build/vega.min.js"),
        file("vega-lite/build/vega-lite.min.js"),
        file("vega-embed/build/vega-embed.min.js"),
        `(() => {\n${interpreter}\n})();`,
      ].join("\n;\n");
      return `export default ${JSON.stringify(code)};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), chartRuntime()],
  // Relative paths, so the build works under any GitHub Pages path.
  base: "./",
  // loro-crdt's wasm module uses top-level await, supported by all current browsers.
  build: { target: "esnext" },
  server: { port: 5180 },
});
