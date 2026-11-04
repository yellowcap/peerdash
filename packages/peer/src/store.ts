// Disk storage of the agent peer.
//
// <home>/canvases/<id>.loro   Loro snapshot with full history
// <home>/rooms.json           canvasId → room key
//
// <home> is $PEERDASH_HOME (the plugin sets it to its data directory), or
// ~/.peerdash.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class Store {
  readonly home: string;

  constructor(home = process.env.PEERDASH_HOME || join(homedir(), ".peerdash")) {
    this.home = home;
    mkdirSync(join(home, "canvases"), { recursive: true });
  }

  loadCanvas(id: string): Uint8Array | null {
    try {
      return new Uint8Array(readFileSync(this.canvasPath(id)));
    } catch {
      return null;
    }
  }

  saveCanvas(id: string, snapshot: Uint8Array) {
    atomicWrite(this.canvasPath(id), snapshot);
  }

  canvasIds(): string[] {
    return readdirSync(join(this.home, "canvases"))
      .filter((f) => f.endsWith(".loro"))
      .map((f) => f.slice(0, -5));
  }

  roomKey(id: string): string | null {
    return this.rooms()[id] ?? null;
  }

  setRoomKey(id: string, key: string) {
    atomicWrite(join(this.home, "rooms.json"), JSON.stringify({ ...this.rooms(), [id]: key }, null, 2));
  }

  private rooms(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(join(this.home, "rooms.json"), "utf8"));
    } catch {
      return {};
    }
  }

  private canvasPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid canvas id: ${id}`);
    return join(this.home, "canvases", `${id}.loro`);
  }
}

function atomicWrite(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
