import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseJoinHash } from "@peerdash/core";
import { CanvasPage } from "./CanvasPage";
import { Library } from "./Library";
import { liveFlag, roomKey } from "./storage";
import "@xyflow/react/dist/style.css";
import "./styles.css";

function route(): { page: "library" } | { page: "canvas"; id: string } {
  const join = parseJoinHash(location.hash);
  if (join) {
    // Keep the key in this browser, then drop it from the address bar.
    roomKey.set(join.canvasId, join.key);
    liveFlag.set(join.canvasId, true);
    history.replaceState(null, "", `#/c/${encodeURIComponent(join.canvasId)}`);
    return { page: "canvas", id: join.canvasId };
  }
  const m = location.hash.match(/^#\/c\/([^/]+)$/);
  return m ? { page: "canvas", id: decodeURIComponent(m[1]) } : { page: "library" };
}

function App() {
  const [r, setR] = useState(route);
  useEffect(() => {
    const onHash = () => setR(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return r.page === "canvas" ? <CanvasPage key={r.id} id={r.id} /> : <Library />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
