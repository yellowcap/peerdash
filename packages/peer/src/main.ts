// peerdash agent peer: an MCP server (stdio) that is also a peer on the canvas.
//
// Environment:
//   PEERDASH_HOME     where canvases and room keys are kept (default ~/.peerdash)
//   PEERDASH_NAME     name shown to other peers (default "Claude")
//   PEERDASH_APP_URL  web app address used in share links (default GitHub Pages)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RTCPeerConnection } from "werift";
import { connectTrystero } from "@peerdash/core/trystero";
import { AgentPeer } from "./peer";
import { createServer } from "./tools";

// stdout carries the MCP protocol. Route any stray logging to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const peer = new AgentPeer({
  name: process.env.PEERDASH_NAME || "Claude",
  appUrl: process.env.PEERDASH_APP_URL || undefined,
  connect: (key) => connectTrystero(key, { rtcPolyfill: RTCPeerConnection }),
});

const server = createServer(peer);
await server.connect(new StdioServerTransport());

const shutdown = () => {
  peer.leaveAll();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
