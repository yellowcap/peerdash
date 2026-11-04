// Dev tool: talk to the peerdash MCP server like a chat app would.
//   node scripts/mcp-repl.mjs [server.mjs]
// Then type lines like:  create_widget {"type":"note","content":"hi"}

import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = process.argv[2] ?? new URL("../../../plugins/peerdash/server/peerdash.mjs", import.meta.url).pathname;
const client = new Client({ name: "peerdash-repl", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [server], env: { ...process.env }, stderr: "inherit" }));
const { tools } = await client.listTools();
console.log(`connected; tools: ${tools.map((t) => t.name).join(", ")}`);

for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = line.trim().match(/^(\w+)\s*(.*)$/);
  if (!m) continue;
  try {
    const res = await client.callTool({ name: m[1], arguments: m[2] ? JSON.parse(m[2]) : {} });
    console.log(`>>> ${m[1]}\n${res.content.map((c) => c.text).join("\n")}\n`);
  } catch (e) {
    console.log(`!!! ${e.message}`);
  }
}
await client.close();
