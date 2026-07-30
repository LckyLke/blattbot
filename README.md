# 🍃 BlattBot

An agentic LaTeX editor that syncs with any Overleaf. BlattBot runs on your machine with a Claude agent built in. You can create local projects, write in the CodeMirror editor, compile, and manage your bibliography without ever touching Overleaf. When you want Overleaf, it connects to any instance, overleaf.com or self-hosted, over the git bridge or your browser session. Agent edits land as diffs. Only what you approve gets committed or pushed.

![BlattBot demo](docs/assets/demo.gif)

*A real agent session, sped up to 28 seconds.*

```
Overleaf ⇄ local mirror ⇄ Claude agent (edit → compile → verify)
                       ⇩
         you review the proof → approve → push
```

## Quickstart

```bash
npx blattbot
```

This starts the app on http://127.0.0.1:4560 and opens your browser. On first run BlattBot checks your environment and offers to download [tectonic](https://tectonic-typesetting.github.io) if no TeX engine is found. Run `npx blattbot --help` for flags and `npx blattbot doctor` to see what it detects.

You need Node 20 or newer, git, and [Claude Code](https://claude.com/claude-code) installed and logged in. BlattBot reuses the Claude Code login, so there is no API key to configure.

## What it does

The agent works in a local git mirror and every turn ends in a diff you approve or discard, per file or even per hunk. It compiles after editing and fixes its own LaTeX errors before showing you anything. A citation pipeline searches OpenAlex, Semantic Scholar, DBLP and Crossref, fetches BibTeX, dedupes against your bibliography and inserts the right cite keys. The editor is CodeMirror with LaTeX autocompletion for commands, environments, your own cite keys and labels. The PDF preview is interactive. Double clicking jumps to the matching source line and selected text can be quoted into the chat.

It works with overleaf.com, university and self-hosted Community Edition instances, plain git remotes, and purely local projects that you can publish to Overleaf later. The exact system prompt, tools and model are visible in the settings.

## Connecting

Sign in once per Overleaf instance. The easiest way is "Sign in from browser session", which imports the login you already have in Firefox, Chrome or most other browsers. There is also a login window for SSO and a manual cookie paste as fallback. Your projects then appear on the dashboard and import with one click.

Instances with the git bridge (paid overleaf.com plans, Server Pro) can also be connected through a git URL. Cookie mode covers everything else, including Community Edition servers without a bridge. Session cookies expire eventually. BlattBot refreshes them from your browser automatically and marks the account disconnected only if that fails.

## Security

The server binds to 127.0.0.1 only, checks the Host header on every request and requires a local auth token for the API, so other users and web pages cannot drive it. Secrets live in `~/.local/share/blattbot` with 0600 permissions. Treat that folder like `~/.ssh`. Overleaf cookies are only ever sent to your own Overleaf instance. The agent is blocked from running git commit or push because version control belongs to the review flow.

## Development

npm workspaces. `server/` is Fastify and TypeScript, `web/` is React and Vite.

```bash
npm install
npm run dev                            # server on :4560
npm run dev:web                        # Vite dev server on :4561
npm test                               # unit tests
npx tsx server/scripts/ui-verify.ts    # browser UI verification without agent turns
npx tsx server/scripts/e2e.ts          # full loop with a real agent turn
npm run release:pack                   # build and pack the npm tarball
```

CI runs the suite on Ubuntu, macOS and Windows.

## License

[MIT](LICENSE), Luke Friedrichs
