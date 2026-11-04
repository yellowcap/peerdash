import { useState } from "react";

const INSTALL = ["/plugin marketplace add yellowcap/peerdash", "/plugin install peerdash@peerdash"];
const INSTALL_SHELL = "claude plugin marketplace add yellowcap/peerdash && claude plugin install peerdash@peerdash";

function Command({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="command">
      <code title={text}>{label ?? text}</code>
      <button className="ghost" onClick={copy} aria-label={`Copy ${text}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** How to bring a chatbot onto a canvas: install the plugin once, then join with the link. */
export function AgentSetup({ link }: { link?: string }) {
  return (
    <div className="agent-setup">
      <ol>
        <li>
          <strong>Install the plugin once</strong> in Claude Code. Type these two commands in a session:
          {INSTALL.map((c) => (
            <Command key={c} text={c} />
          ))}
          <details>
            <summary>Or from a terminal</summary>
            <Command text={INSTALL_SHELL} />
          </details>
          <span className="muted">Needs Node.js 20 or later. Start a new session after you install.</span>
        </li>
        <li>
          {link ? (
            <>
              <strong>Connect it to this canvas:</strong>
              <Command text={`/peerdash:join ${link}`} label={`/peerdash:join ${link.slice(0, 40)}…`} />
              <span className="muted">Or paste the link and say “join this”.</span>
            </>
          ) : (
            <>
              <strong>Ask for a dashboard</strong>, for example “make me a peerdash dashboard of our open issues”. Claude gives you a link to
              open here. To bring Claude to a canvas you already have, open it, click <strong>Share → Go live</strong> and follow the steps there.
            </>
          )}
        </li>
      </ol>
      <p className="muted small">
        Claude then joins as one more peer: it sees what you select and edits live. It runs on your computer, so nothing goes through a server of
        ours.{" "}
        <a href="https://github.com/yellowcap/peerdash#use-it-with-claude-code" target="_blank" rel="noreferrer">
          More
        </a>
      </p>
    </div>
  );
}
