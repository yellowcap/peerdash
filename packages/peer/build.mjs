// Bundle the agent peer into one file for the Claude Code plugin.
// Plugin installs copy only the plugin folder, so the bundle carries all
// dependencies. loro-crdt/base64 inlines the WebAssembly; werift is pure JS.

import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "../../plugins/peerdash/server/peerdash.mjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  legalComments: "linked",
  alias: { "loro-crdt": "loro-crdt/base64" },
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __pdRequire } from 'node:module';",
      "const require = __pdRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
