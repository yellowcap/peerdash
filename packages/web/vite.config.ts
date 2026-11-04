import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
  // Relative paths, so the build works under any GitHub Pages path.
  base: "./",
  // loro-crdt's wasm module uses top-level await, supported by all current browsers.
  build: { target: "esnext" },
  server: { port: 5180 },
});
