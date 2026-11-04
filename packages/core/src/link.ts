// Share links and the secrets behind them.
//
// A link looks like  https://host/path/#/join/<canvasId>/<key>
// Everything after `#` stays in the browser: it is never sent to the web
// server. The key is the room password: peers without it cannot complete the
// connection handshake. The room name on the public signalling relays is
// derived from the key, so it reveals neither the canvas nor the key.

export const DEFAULT_APP_URL = "https://yellowcap.github.io/peerdash/";

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function roomIdFor(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`peerdash-room:${key}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `appUrl` is the web app's address, e.g. `https://yellowcap.github.io/peerdash/`. */
export function shareLink(appUrl: string, canvasId: string, key: string): string {
  return `${appUrl.replace(/#.*$/, "")}#/join/${encodeURIComponent(canvasId)}/${key}`;
}

export function parseJoinHash(hash: string): { canvasId: string; key: string } | null {
  const m = hash.match(/^#\/join\/([^/]+)\/([A-Za-z0-9_-]{16,})$/);
  return m ? { canvasId: decodeURIComponent(m[1]), key: m[2] } : null;
}

/** Accepts a full share link or only its `#/join/…` part. */
export function parseLink(link: string): { canvasId: string; key: string } | null {
  const i = link.indexOf("#");
  return i < 0 ? null : parseJoinHash(link.slice(i).trim());
}
