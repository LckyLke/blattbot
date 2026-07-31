# Security

How BlattBot handles your credentials and your text, what leaves your machine, and how to report problems. Statements here describe the code as shipped; file an issue if you find a mismatch.

## Local server surface

The server listens on `127.0.0.1` only. On top of that:

- Every request must carry an allowlisted `Host` header (`127.0.0.1`, `localhost`, or `[::1]` with the server's port), which defeats DNS-rebinding attacks.
- Every `/api` request must present a per-install auth token: 32 random bytes generated on first run and stored with `0600` permissions in the data dir. The web app receives it once via same-origin `/api/bootstrap` and sends it back as a `SameSite=Strict` cookie, which cross-site pages can neither read nor send. Scripts use `Authorization: Bearer <token>`.
- CORS is a fixed allowlist (the app's own origin plus the Vite dev server on port 4561) — the server never reflects arbitrary origins.

The result: other users on the machine and web pages you visit cannot drive the API.

## Credential storage

Overleaf session cookies and git tokens live in `~/.local/share/blattbot` (override with `BLATTBOT_DATA_DIR`): `accounts.json` holds per-instance session cookies, `projects.json` holds git tokens for git-bridge projects. Both files are written with `0600` permissions and the data dir itself is `0700`. Treat the folder like `~/.ssh`.

There is no OS-keychain integration yet — file permissions are the protection, chosen so the same code works headless and across Linux/macOS/Windows. Keychain support is a reasonable future step.

To revoke access: log out of Overleaf in your browser (invalidates the session server-side), and/or delete `accounts.json`. Deleting the whole data dir removes every stored credential and token.

## Browser cookie import

"Sign in from browser session" reads the cookie stores of browsers installed on your machine (Firefox, Chrome, Edge, Brave, Chromium, …) to find an existing Overleaf login. This runs with your own OS user's privileges and reads only what you could already read yourself — the same cookies your browser sends to Overleaf on every visit. The imported session cookie is stored locally as described above and is only ever sent to the Overleaf instance it belongs to. It never leaves your machine otherwise. The alternative "assisted login" opens a real browser window on the instance's login page and captures the session cookie when it appears (this also works with SSO).

## What is sent where

- **Your configured model provider.** Agent turns send project text and any context you attach to Anthropic (via your Claude Code login) or to the OpenAI-compatible endpoint you configure. Nothing is sent until you start a turn.
- **Your Overleaf instance.** Sync, push, and "Verify on Overleaf" talk to the instance a project is connected to, and to nothing else.
- **Citation services.** Paper search and the citation audit query `api.openalex.org`, `api.semanticscholar.org`, `dblp.org`, `api.crossref.org`, `doi.org`, and `export.arxiv.org` with search queries, titles, and DOIs — never your manuscript itself.
- **Open-access PDF hosts.** The References tab's fetch-PDF action downloads a paper's PDF from `arxiv.org` or from whatever open-access URL Semantic Scholar reports for it — which can be any publisher's host (e.g. a journal or conference CDN). This happens only when you trigger the fetch, and sends nothing but the request for that PDF.
- **npm registry.** An update check fetches `registry.npmjs.org/blattbot/latest` at most once a day. No telemetry, no analytics; nothing else phones home.

## Prompt injection

File contents, PDFs, and attached context are treated as data, not instructions: the system prompt directs the agent to ignore directives embedded in them, to flag text taken from untrusted sources, and to add citations only via the citation tools from resolvable identifiers (DOI, dblp key, arXiv id) — never from memory. The agent is also blocked from running `git commit`, `push`, `checkout`, `reset`, and `rebase` at the tool-permission level. The structural defense is the approval gate: every change, however produced, is a diff a human reviews before it can be committed or pushed.

## Data-safety mechanisms

- Approving a change checks Overleaf for remote drift first. A push that would overwrite remote edits is blocked and the conflicting files are listed; nothing is committed or pushed.
- If you force the push anyway, the remote versions are backed up first, under `<project>/.git/blattbot/remote-backup/<timestamp>/`.
- Remote changes to files you have not touched are merged into your local mirror rather than lost, both on sync and after a push.
- Document updates are applied in place over Overleaf's realtime protocol (preserving comments, tracked changes, and history); on failure BlattBot falls back to a plain upload and reports it.

## Overleaf terms of service

Cookie-session sync drives Overleaf's internal web API — the same endpoints your browser uses — which is unofficial and not a supported integration. It exists primarily for Community Edition and self-hosted servers, which have no git bridge. On overleaf.com, the supported path is the git bridge (paid plans); use cookie mode there at your own judgment.

## Reporting

Report vulnerabilities or security concerns at https://github.com/lckylke/blattbot/issues. If the issue is sensitive, say so in the issue without details and a private channel will be arranged.
