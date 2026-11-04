import { CanvasDoc } from "@peerdash/core";
import { canvases } from "./storage";

/** `.peerdash` = a Loro snapshot with the full history. */
export function downloadSnapshot(doc: CanvasDoc) {
  const blob = new Blob([doc.snapshot() as BlobPart], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(doc.title || "canvas").replace(/[^\w.-]+/g, "-")}.peerdash`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Opening a file of a canvas that is already here merges the two copies. */
export async function importFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const incoming = CanvasDoc.fromSnapshot(bytes);
  if (!incoming.ready) throw new Error("This file is not a peerdash canvas.");
  const existing = await canvases.get(incoming.id);
  const doc = existing ? CanvasDoc.fromSnapshot(existing.snapshot) : incoming;
  if (existing) doc.applyRemote(bytes);
  await canvases.put({ id: doc.id, title: doc.title, snapshot: doc.snapshot(), updatedAt: Date.now() });
  return doc.id;
}
