# 🍃 BlattBot (beta)

A local bridge and review layer for Overleaf projects. BlattBot mirrors a project into a git checkout on your machine and syncs it with **any** Overleaf instance — including Community Edition and self-hosted servers that have no git bridge at all, which it reaches through your existing browser session. Git-bridge instances and pure-local projects work too.

Every change, whether you typed it or the built-in agent made it, lands as a reviewable diff. Approving pushes it to Overleaf; nothing lands without your approval. Before a push, BlattBot checks the remote for changes made in the meantime: remote-only edits are absorbed, and a push that would overwrite someone's work is blocked until you resolve it. Document updates are applied in place over Overleaf's own realtime protocol, so comments, tracked changes, and per-document history survive a push.

![BlattBot demo](docs/assets/demo.gif)

*A real agent session: literature search, citations added to the bibliography and cited in the text, then approved and pushed. Sped up.*

```
Overleaf (any instance) ⇄ local git mirror ⇄ editor + Codex agent
                        ⇩
          you review the diff → approve → push
```

## Quickstart

```bash
npx blattbot
```

This starts the app on http://127.0.0.1:4560 and opens your browser. On first run BlattBot checks your environment and offers to download [tectonic](https://tectonic-typesetting.github.io) if no TeX engine is found. Run `npx blattbot --help` for flags and `npx blattbot doctor` to see what it detects.

You need Node 20 or newer, git, and the current [Codex CLI](https://developers.openai.com/codex/cli) installed and signed in:

```bash
npm install -g @openai/codex
codex login
```

**Codex is the default background harness.** BlattBot reuses your Codex login and configured model. Settings → Agent checks the connection and lets you choose a model or reasoning effort. Set `BLATTBOT_CODEX_EXECUTABLE=/path/to/codex` to use a custom installation. The integration uses the [Codex app-server protocol](https://developers.openai.com/codex/app-server), including its experimental dynamic-tool interface; keep the CLI up to date. Codex reports token usage, but does not supply a dollar cost.

You can also select **Claude Code** (your existing login or an Anthropic API key) or an **OpenAI-compatible API** in Settings → Agent. Explicit backend choices are preserved; an empty backend setting now selects Codex. Changing backends starts a separate model conversation while keeping earlier messages visible in the chat. Global model settings and new project overrides are scoped to their harness. Background helpers such as paper summaries use the selected backend too; an incomplete configuration produces an error instead of silently switching providers.

The optional Claude backend runs through the Claude Agent SDK, which is included with BlattBot and bundles its own copy of the Claude Code engine — npm downloads a platform binary of roughly 200 MB on install. To use a `claude` binary you already have instead, set `BLATTBOT_CLAUDE_EXECUTABLE=/path/to/claude`; `npx blattbot doctor` shows which engine is in use.

## Sync without clobbering

- **Drift detection.** Approving a change first fetches a fresh snapshot from Overleaf. Files that changed both remotely and locally block the push with a per-file conflict list; you can discard your version per file, or force the push — in which case the remote versions are backed up locally first.
- **Selective merge.** Remote changes to files you have not touched are merged into your mirror as their own commit, both during a normal sync and after a push.
- **In-place updates.** Edited documents are updated through Overleaf's realtime protocol rather than deleted and re-uploaded, so entity ids are preserved and comments, tracked changes, and per-document history stay attached. If an in-place update fails, BlattBot falls back to a plain upload and tells you.

## The agent

The agent works in the local git mirror and every turn ends in a diff you approve or discard. It compiles after editing and fixes its own LaTeX errors before showing you anything.

- **Citations.** A pipeline searches OpenAlex, Semantic Scholar, DBLP, and Crossref, fetches BibTeX, dedupes against your bibliography (by DOI and title), normalizes entries, upgrades arXiv preprints to the published version when one exists, and inserts the right cite keys. A deterministic audit checks every entry against Crossref/OpenAlex and badges it verified, unresolved, or mismatched.
- **Rendered PDF diff.** Besides the text diff, the Proof tab can render the current and pre-change PDFs and highlight the pages and regions that visually changed — the latexdiff use case, without Perl.
- **Edit in Proof.** Click **Edit** on a file or passage to revise it inside the Proof pane. The full editor supports autocomplete, undo, and Ctrl/Cmd+S; drafts stay in sync with Source. Save locally, return to the diff, then approve when ready.
- **External context.** Link the paper's codebase, an experiment folder, or a stack of PDFs (sidebar → External context → *Browse folders…*). The agent may read and grep them but never edit them, and they never sync to Overleaf. Each turn starts from a fresh listing of what those folders contain, so the agent can check the manuscript against the thing it describes — a formula against the implementation, a stated hyperparameter against the config, a reported number against the results — and is told to report a disagreement rather than quietly rewrite the text.
- **Cost transparency.** Every turn shows its cost (or token count), each project shows a running total, and a disclosure generator writes an AI-use statement from your actual usage logs — useful for venue and institutional AI policies.
- **Review mode.** A structured referee-report mode with a venue-style rubric; file edits are blocked in it.
- **Understand mode.** A read-only Q&A mode that explains the project's text, math, and arguments, grounding every answer in quoted passages from your files; file edits are blocked in it too.

## Honesty notes

- The local compile is a **preflight** using Tectonic (or your local TeX). Overleaf runs its own TeX Live, which can differ — the "Verify on Overleaf" button runs Overleaf's own compiler on the pushed state and shows you that PDF.
- Cookie-session sync drives Overleaf's internal web API, which is unofficial. It is primarily intended for Community Edition and self-hosted servers that have no git bridge; see [SECURITY.md](SECURITY.md).
- Your project text and the context you attach are sent to the model provider you configure (Codex, Anthropic via Claude Code, or an OpenAI-compatible endpoint). Check your venue's and institution's AI policy — the disclosure generator helps with that.

## Why not just Codex or Claude Code?

Codex or Claude Code in a folder can edit LaTeX. BlattBot adds what a bare CLI session doesn't have: sync with Overleaf instances that have no git bridge, a review/approval gate so no agent output reaches your document unchecked, entity-preserving pushes that keep comments and tracked changes alive, a compile preflight plus verification on Overleaf's own compiler, rendered PDF diffs, and a citation pipeline with deterministic auditing instead of model-remembered BibTeX.

## Connecting

Sign in once per Overleaf instance. The easiest way is "Sign in from browser session", which imports the login you already have in Firefox, Chrome or most other browsers. Inside WSL it reads the Windows browsers too; use Firefox there, since Chrome and Edge on Windows keep their cookies locked to the browser (app-bound encryption).

Instances with the git bridge (paid overleaf.com plans, Server Pro) can also be connected through a git URL.

## Security

The server binds to 127.0.0.1 only, checks the Host header on every request and requires a local auth token for the API, so other users and web pages cannot drive it. Secrets live in `~/.local/share/blattbot` with 0600 permissions. Treat that folder like `~/.ssh`. Overleaf cookies are only ever sent to your own Overleaf instance. The agent is blocked from running git commit or push. Details, including what data leaves your machine and how to revoke credentials, are in [SECURITY.md](SECURITY.md).

## Install from source

```bash
git clone https://github.com/LckyLke/blattbot.git
cd blattbot
npm install
npm run build --workspace=web
npm run dev
```

The app then runs on http://127.0.0.1:4560, same as the npx version.

## Development

npm workspaces. `server/` is Fastify and TypeScript, `web/` is React and Vite.

```bash
npm install
npm run dev                            # server on :4560
npm run dev:web                        # Vite dev server on :4561
npm test                               # unit tests
npm run codex:check --workspace=server # installed Codex protocol check, no model turn
npm run test:ui --workspace=server     # browser verification (local mocks)
npx tsx server/scripts/ui-verify.ts    # browser UI verification without agent turns
npx tsx server/scripts/e2e.ts          # full loop with a real agent turn
npm run release:pack                   # build and pack the npm tarball
```

CI runs the suite on Ubuntu, macOS and Windows. Release notes live in [CHANGELOG.md](CHANGELOG.md).

## License

Source-available under [PolyForm Noncommercial 1.0.0](LICENSE), Luke Friedrichs. Free for personal, academic, and other noncommercial use.
