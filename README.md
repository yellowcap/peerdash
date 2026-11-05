# peerdash

A local-first infinite canvas for dashboards. People edit the same canvas from
their browsers, peer to peer. Your chatbot joins the same canvas as one more
peer: it reads the canvas and adds or changes widgets while you watch.

- **No server.** The web app is static files on GitHub Pages. Canvases stay in
  your browser. Data goes directly between peers over WebRTC.
- **Your own chatbot.** The agent peer runs on your computer, started by your
  chat app. We pay for no model calls and see no data.
- **HTML widgets.** The agent (or you) can put any HTML on the canvas. It runs
  in a sandbox with no network access unless you allow it.

App: <https://yellowcap.github.io/peerdash/>

For AI agents: <https://yellowcap.github.io/peerdash/llms.txt>
([llms.txt v2](https://llmstxt.org/)). It tells an agent how to install the
plugin and how to make or join a canvas. The full guide is
[`index.md`](packages/web/public/index.md).

## Use it with Claude Code

Install the plugin from this repository:

```
/plugin marketplace add yellowcap/peerdash
/plugin install peerdash@peerdash
```

Or from a shell:

```bash
claude plugin marketplace add yellowcap/peerdash && claude plugin install peerdash@peerdash
```

Then start a new Claude Code session and ask, for example:

> Make me a peerdash dashboard of our open GitHub issues by label.

Claude makes a canvas and gives you a link. Open the link: the widgets appear
as Claude makes them. Select a widget in the browser and say "make this one
bigger" or "add a legend here". Claude sees your selection and your view.

To bring Claude to a canvas you already have, open **Share → Go live** in the
browser, copy the link, and say `/peerdash:join <link>`.

The plugin needs Node.js 20 or later.

### Update the plugin

Run these in a terminal, then start a new Claude Code session:

```bash
claude plugin marketplace update peerdash
claude plugin update peerdash@peerdash
```

The first command gets the latest version from GitHub. The second installs
it. The `/plugin marketplace update` command inside a session does not always
fetch the latest version. If `/plugin` still shows an old version, use the
terminal commands.

## How it works

```
 Claude Code ──MCP (stdio)──▶ agent peer (Node, on your computer)
                                 │  own copy of the canvas, saved to disk
                                 ▼
                      WebRTC, peer to peer (signalling: public Nostr relays)
                                 ▲
 your browser ── static app from GitHub Pages ── other people's browsers
```

- Each canvas is a [Loro](https://loro.dev) CRDT document. Peers exchange
  Loro updates; merges need no server.
- [Trystero](https://github.com/dmotz/trystero) finds peers through public
  Nostr relays. The relays only see encrypted connection offers for an
  opaque room name.
- The agent peer is an MCP server and a peer in one process. It uses
  [werift](https://github.com/shinyoshiaki/werift-webrtc) (WebRTC in plain
  JavaScript), so it needs no native binary. The chat sees only tools such as
  `get_outline`, `create_widget` and `get_widget_feedback`, never sync data.
- Browsers send presence: name, selection, view, and errors from HTML
  widgets. That is how the agent knows what "this" and "here" mean, and how it
  fixes a broken widget without your help.

See [PLAN.md](PLAN.md) for the design and roadmap.

## Security

- **The share link is full edit access.** Anyone with it can edit. Give it
  only to people and agents you trust. "New link" stops old links from
  working.
- **HTML widgets run in a sandbox:** an iframe without same-origin access, and
  a content security policy that blocks all network access except the
  origins you allow per widget.
- **Canvas content is data.** The agent's instructions tell it not to follow
  instructions it finds on a canvas. This lowers, but does not remove, the
  risk of prompt injection from other peers.
- Author names are self-declared.

## Develop

```bash
pnpm install
pnpm dev          # web app on http://localhost:5180
pnpm test         # unit tests
pnpm typecheck
pnpm bundle       # rebuild plugins/peerdash/server/peerdash.mjs
```

Run Claude Code with the plugin from this checkout, and share links that point
to the local web app:

```bash
PEERDASH_APP_URL=http://localhost:5180/ claude --plugin-dir ./plugins/peerdash
```

Talk to the agent peer without a chat app:

```bash
PEERDASH_APP_URL=http://localhost:5180/ node packages/peer/scripts/mcp-repl.mjs
```

Then type lines like `new_dashboard {"title":"Test"}`.

Layout:

| Path | What |
|---|---|
| `packages/core` | Canvas document, sync protocol, links, layout. Shared by all. |
| `packages/web` | The web app (Vite, React, React Flow). |
| `packages/peer` | The agent peer: MCP server + peer. |
| `plugins/peerdash` | The Claude Code plugin. `server/` holds the bundled peer. |
| `.claude-plugin/marketplace.json` | Makes this repository a plugin marketplace. |

## License

MIT
