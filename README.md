# 🍃 BlattBot (beta)

A local bridge and review layer for Overleaf projects. BlattBot mirrors a project into a git checkout on your machine and syncs it with **any** Overleaf instance — including Community Edition and self-hosted servers that have no git bridge at all, which it reaches through your existing browser session. Git-bridge instances and pure-local projects work too.

Every change, whether you typed it or the built-in agent made it, lands as a reviewable diff. Approving pushes it to Overleaf; nothing lands without your approval. Before a push, BlattBot checks the remote for changes made in the meantime: remote-only edits are absorbed, and a push that would overwrite someone's work is blocked until you resolve it. Document updates are applied in place over Overleaf's own realtime protocol, so comments, tracked changes, and per-document history survive a push.

![BlattBot demo](docs/assets/demo.gif)

[Watch BlattBot in action](https://blattbot.com/#demos) — a real agent edit, compilation, diff review and local approval, followed by editor and Research walkthroughs.

*Ask for a change, review the result, then approve it. Recorded in the current source build with a real agent; waiting periods shortened.*

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
- **Reference browsing.** Group references by shared authors, year, conference/journal, CORE conference rank, cited/unused status, publication type, or bibliography file. Groups collapse, work with search, and remember your choice per project. Shared-author groups connect matching full author names through coauthors, with each paper shown once. Venue details include sourced citation counts and, when a conference can be matched exactly, a linked CORE/ICORE rating with its edition. Rankings come from the official portal's latest export, cached for a week; the displayed edition is not necessarily the paper's publication-year ranking. Missing or ambiguous matches stay unrated.
- **Reading papers for Related Work.** All backends can open individual references with `read_paper`, search their text, and follow page-labeled excerpts beyond the first context window. It uses an attached PDF (an exact cite-key filename, or a specified path), then an open-access PDF, then an abstract. Upload PDFs through **External context**; local source associations are remembered and checked against the current bibliography title. Abstract-only evidence, unavailable or mismatched sources, and unreadable pages generate visible chat notices. Changed citation passages whose papers were not opened in the turn are also flagged independently of the model's reply.
- **Rendered PDF diff.** Besides the text diff, the Proof tab can render the current and pre-change PDFs and highlight the pages and regions that visually changed — the latexdiff use case, without Perl.
- **Edit in Proof.** Click **Edit** on a file or passage to revise it inside the Proof pane. The full editor supports autocomplete, undo, and Ctrl/Cmd+S; drafts stay in sync with Source. Save locally, return to the diff, then approve when ready.
- **External context.** Link the paper's codebase, an experiment folder, or a stack of PDFs (sidebar → External context → *Browse folders…*). The agent may read and grep them but never edit them, and they never sync to Overleaf. Each turn starts from a fresh listing of what those folders contain, so the agent can check the manuscript against the thing it describes — a formula against the implementation, a stated hyperparameter against the config, a reported number against the results — and is told to report a disagreement rather than quietly rewrite the text.
- **Git repository evidence.** Use **External context → Git repositories → Add repository**, or **Research → Checks → Verify claims against code**. Attach an HTTPS/SSH Git URL or a local Git repository and select a branch, tag or commit. BlattBot records an immutable commit snapshot, outside the manuscript. Private repositories use your existing Git credential helper or SSH setup; passwords/tokens in URLs and interactive login are unsupported. SSH hosts must already be trusted. Local uncommitted changes are excluded; use a linked folder when those changes are the intended evidence.
- **Cost transparency.** Every turn shows its cost (or token count), each project shows a running total, and a disclosure generator writes an AI-use statement from your actual usage logs — useful for venue and institutional AI policies.
- **Review mode.** A structured referee-report mode with a venue-style rubric; file edits are blocked in it.
- **Understand mode.** A read-only Q&A mode that explains the project's text, math, and arguments, grounding every answer in quoted passages from your files; file edits are blocked in it too.

## Research workspace

Open **Research** in either project pane. The writing tools are available to Codex, Claude and OpenAI-compatible backends.

- **Evidence:** checks every detected cited passage separately. Assessments retain exact, source-locatable quotations, PDF page numbers, retrieval time and source versions. Claim, bibliography, PDF or OCR changes invalidate affected assessments. A model assessment is reviewable evidence, not a guarantee of correctness.
- **Source-based writing:** ask the agent to draft Related Work or other sections from your sources, edit the proposed text in Proof, then approve it. Missing papers and unsupported claims stay explicit. Comparison analysis and outlines are optional aids, with no row-review or outline-approval step.
- **Checks:** find undefined or duplicate citation keys, case collisions, duplicate DOI/title records and missing metadata. Verify publication identities against indexes separately. Review conclusions, numbers, comparison conditions, causal wording and definitions across the manuscript and explicitly selected text/CSV/code files. Findings retain file quotations and input versions; the report states when content was truncated. Compile to check BibTeX/Biber syntax.
- **Memory:** save the research question, intended contribution, definitions, notation, methods, decisions and open questions. Accepted memory accompanies new chat turns. Model proposals require your review; previous versions can be restored.
- **Discover:** searches retain queries, criteria, results, dates and inclusion/exclusion decisions. Follow backward and forward citation links and check indexed publisher/retraction notices. Connect a local or web Zotero library to import BibTeX, available PDFs and notes as attached text. Imports do not write to Zotero. Some attachment storage services require manual PDF attachment.
- **Graph:** the default Research view automatically builds a directed citation graph for all existing projects at server startup and updates it after bibliography changes. Cached sources are reused; progress and unresolved lookups remain visible, with delayed retries for service failures. No model call is needed. Inspect project sources and external references. Arrows mean **A cites B**. Click nodes, expand their references, search, pan/zoom, inspect shared references, and find missing works ranked by how many project papers cite them. This ranking is a discovery aid, not a relevance/quality score. Newly imported DOI matches become project nodes. Unresolved records and failed lookups remain visible.

Codex can query the same persistent graph through `query_citation_graph`:

```json
{"query":"neighbors","node":"smith2020","direction":"outgoing"}
{"query":"shared_references","nodes":["smith2020","jones2021"]}
{"query":"missing","limit":20,"offset":0}
{"query":"path","node":"smith2020","target":"jones2021","maxDepth":6}
```

Keys and OpenAlex work IDs both identify nodes. Responses are structured JSON with provenance, coverage notices and pagination. `update_citation_graph` fetches pending project works or expands a selected node. Automatic indexing continues through all pending project entries in the background, sharing one worker across projects. Manual tool builds handle up to 20 pending entries (30 explicitly selected). Each paper contributes up to 1,000 references; saved graph views cap at 5,000 nodes/20,000 edges and show truncation. The canvas shows up to 80 nodes at once; queries use the full saved graph. An absent edge or path means **not found in the loaded index**, not that no relationship exists. Read a paper before using its citation relationship as a reason to cite it.

PDF page images prefer **Poppler** (`pdftoppm`) and fall back to PDF.js. OCR requires **Tesseract**. On Ubuntu/WSL, install both with `sudo apt install poppler-utils tesseract-ocr`; on macOS use `brew install poppler tesseract`. On Windows, install the native tools and add their executable directories to PATH. Override their paths with `BLATTBOT_PDFTOPPM` and `BLATTBOT_TESSERACT`. Evidence → Read a paper reports availability and offers exact/semantic search, OCR and visual figure/table inspection. OCR is cached by PDF content and page; only requested pages (plus the title page) are recognized. Visual interpretation requires an image-capable model in the selected backend. Verify recognized numbers and equations against the original image. Semantic search expands scientific synonyms and reranks source excerpts with the model; it is not an exhaustive semantic index.

Zotero settings: enable local API access under Zotero's Advanced settings and normally use user library `0`; for web access, supply the numeric user/group ID and a read-only API key for private libraries. Keys are stored separately from agent-readable project data. [Zotero API documentation](https://www.zotero.org/support/dev/web_api/v3/basics). OpenAlex supports keyless basic access and an optional `OPENALEX_API_KEY` environment variable for a larger request budget; credentials are sent only to OpenAlex. [Authentication](https://help.openalex.org/api/authentication/). Publication checks query Crossref notices that target the cited DOI, including indexed Retraction Watch data. No flag is not proof of no retraction. [Crossref update filters](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/).

Research artifacts are saved locally under the BlattBot data directory. New checks and writing helpers use the selected model and may incur its normal usage costs. Run `npm run test:research-ui --workspace=server` after building to exercise the workflow against an isolated fixture model, with no paid calls.

### Recovering missing paper sources

`read_paper` tries attached PDFs and indexed open-access locations, then checks bibliography/repository landing pages, Crossref links and web search for author or publisher copies. A known public PDF or paper page can also be supplied with `url`. Downloaded content must match the bibliography title. Search snippets and generic page descriptions are not evidence. Publisher abstracts and book/chapter summaries retain their source URL and retrieval date, are labeled separately from full text, and do not satisfy strict full-text checks.

In **Settings → Agent**, **Save & test** stores a provider key on the running server before checking it. A key saved on another installation is not used here. Semantic Scholar requests are paced, short authenticated rate limits are retried, and alternate source providers remain available. An API key does not grant access to paywalled articles. An optional **Brave Search API key** enables authenticated web discovery; without it, public web search is attempted and may be blocked. Provider charges may apply. Failed searches report access errors without claiming that no public copy exists.

Unsuccessful source lookups are reused for five minutes to avoid repeated requests. `read_paper` with `refresh: true` retries immediately; changes to bibliography fields or provider credentials also invalidate that cache. Cached publisher text is reused for up to 24 hours and refreshed text invalidates affected evidence. A readable PDF supplied through **External context** remains the fallback when online sources cannot be retrieved.

### University and library access

Open **Settings → University access**, choose a publisher (or enter another public HTTPS website), and select **Open institution sign-in**. In the separate browser window, use the publisher's institution selector to choose your university or library and complete sign-in, including MFA. Return to the publisher site and select **Save publisher session** in Blattbot. The optional institution label is for your reference; no university is hardcoded and the publisher handles institution selection.

Blattbot stores only cookies that belong to the selected publisher host. Paper retrieval can use them on that exact HTTPS origin; general `read_url` requests stay anonymous. Cookies for other domains, including a separate university SSO site, and browser local storage are not saved. A saved session is not a verified subscription: title-matched PDF retrieval determines whether a particular paper is available. Reconnect to replace an expired session, or remove the connection to delete the stored cookies. Saving or removing a connection invalidates recent failed discovery lookups. Cached paper PDFs remain available after removal.

The login window requires a desktop display and an installed Chrome, Edge or Chromium on the machine running Blattbot; `BLATTBOT_BROWSER_EXECUTABLE` can select its executable. A login expires after ten minutes if unfinished. Sites that bind access to browser execution, require local storage, block automated requests, or require API access may still need a manual PDF download and attachment. ScienceDirect provides an [official institutional text-mining API](https://dev.elsevier.com/text_mining.html); university web sign-in is not equivalent to API entitlement. This feature does not purchase access or bypass publisher restrictions.

### Verify manuscript claims against a Git repository

For a local repository, choose **Add repository → Local folder → Browse folders…**. The picker marks Git folders, previews the current branch and commit, and recognizes repository roots when you open a subfolder. Use Home/Up, filter folder names, or paste a path (including `~/Projects`). It remembers the last selected folder and fills in the current branch automatically.

In **Research → Checks → Verify claims against code**, optionally name a focus (for example, loss reduction, training defaults, preprocessing, data splits or evaluation metrics), then select **Check manuscript against code**. You can also select **Check code** directly in chat. This starts a read-only agent turn that explores the attached snapshots, identifies manuscript claims, searches for supporting and contradictory code, and saves individual assessments. It uses the selected agent; each saved assessment also uses a separate model call to judge the selected excerpts. Normal provider usage charges apply.

All three backends have the same `inspect_repository` tool:

```json
{"action":"list"}
{"action":"files","repositoryId":"<id>","commit":"<full SHA>","path":"src/","limit":80}
{"action":"search","repositoryId":"<id>","commit":"<full SHA>","query":"reduction"}
{"action":"read","repositoryId":"<id>","commit":"<full SHA>","path":"src/loss.py","startLine":30,"endLine":80}
```

File listings include hidden configuration and support pagination. Search covers tracked text across the snapshot using case-insensitive literal matching. Follow `nextOffset` and `nextLine`; search hits are leads, and the agent must read surrounding code before using them as evidence. `verify_code_claim` takes an exact manuscript quotation and selected Git line ranges with roles such as implementation, caller, configuration, evaluation, test or counterevidence. `list_code_evidence` retrieves saved assessments.

Assessments distinguish **implementation agrees**, **contradiction found**, **insufficient evidence**, and **execution required**. They retain manuscript hashes, full commit and blob identities, inspected excerpts, validated quotations and line numbers, the configured assessor backend/model, limitations and follow-up checks. Export the records as JSON from Checks. Changing the manuscript or refreshing to a different commit marks affected assessments stale; previously fetched commits remain readable until the repository is removed. New versions of a claim's evidence retain earlier snapshot assessments.

This is static evidence review, not a reproducibility certification. No repository code, setup scripts or tests are executed. Empirical findings cannot receive a supported verdict from this tool, and code alone cannot prove a theoretical claim. The agent can miss relevant files, branches or claims, and a real quotation does not guarantee a correct interpretation. Unchecked claims remain unchecked; code assessments do not satisfy the separate strict paper-citation gate.

Snapshots are shallow and include committed files only. Submodules, symlink targets and Git LFS payloads are not fetched or followed. Reads reject binary files and files over 2 MiB; excerpts are limited to 400 lines/40,000 characters, and one assessment accepts up to 12 excerpts/90,000 characters. Git fetches time out after two minutes; source searches have bounded time and output and report failure instead of presenting partial results as complete. Refreshes are explicit. Removing an attachment deletes its managed Git objects, preserves saved evidence as stale, and leaves the original repository untouched.

Run `npm run test:code-ui --workspace=server` after building the web app to exercise attachment, a full agent/tool/assessment loop, evidence export, refresh invalidation and removal in a real browser using a fixture model. Set `BLATTBOT_BROWSER_EXECUTABLE` if Chromium is outside the usual locations. These fixtures test software behavior, not real-model scientific accuracy.

### Writing readiness and long tasks

Enable **Research → Evidence → Strict mode** to block approval while evidence gaps remain. This also applies to forced approval. Cited passages need current full-text support; partial, unsupported, abstract-only and unchecked passages remain open. **Check assertions without citations** classifies uncited passages, including numeric claims and own results. Missing or uncertain classifications remain open. You can accept an individual exception with a recorded reason; changing its text or evidence invalidates that decision. Drafts remain editable. These checks can miss or misclassify assertions, so readiness is a review aid rather than a certification of scientific correctness.

Evidence batches, paper comparisons, outlines, manuscript reviews, library indexing and benchmarks run as persistent **Tasks**. Pause or cancel an active task, or resume failed/interrupted work from saved item checkpoints. A restart leaves interrupted tasks paused for explicit resumption. Provider limits pause work; missing sources produce visible per-item failures. Cancelled work cannot save a late assessment. Re-running a partly completed manuscript audit may repeat its current item. Codex, Claude and OpenAI-compatible backends can inspect and control tasks through `research_tasks` and inspect readiness through `strict_evidence_report`; accepting an evidence exception remains a user action.

### Search the paper library

**Research → Library** builds a persistent index of the complete extractable text of each project paper, within the PDF reader's limits (25 MB, 1,000 pages and five million characters per PDF). Search returns original passages with citation keys and page numbers. Optional synonyms/translations use the selected model. Ranking measures term relevance, not whether a passage supports a claim. Changed PDFs, OCR text or bibliography entries invalidate their index; outdated entries are excluded until refreshed. Abstract-only papers, missing sources and pages without readable text stay visible in coverage. Refresh explicitly to check for newly available remote full text. Image-only material needs OCR or visual inspection.

The same index is available to all backends through `search_library`:

```json
{"query":"generalization on unseen datasets","semantic":true,"limit":20}
{"query":"ablation","keys":["smith2020"],"offset":0}
```

### Scientific quality benchmark

**Research → Checks → Scientific quality benchmark** runs the actual evidence judge and quote validator against versioned reference cases, records the configured model/backend and exports the report as JSON. The 15 starter cases cover matching evidence, wrong numbers, different datasets, partial evidence and unsupported generalizations, using short attributed excerpts from [Attention Is All You Need](https://arxiv.org/abs/1706.03762v7), [BERT](https://arxiv.org/abs/1810.04805v2) and [Deep Residual Learning](https://arxiv.org/abs/1512.03385v1).

Starter labels are **proposals**, not independent human annotations. Review the source and record your judgment before that case contributes to agreement or false-support rates. Expected labels and review notes are excluded from model input. Changed cases require a new review and evaluation. Import your own independently annotated JSON cases for a representative benchmark; the small starter set cannot establish general reliability. Test fixtures validate software behavior and are not measurements of real model quality.

### Find in source and PDF

**Ctrl/Cmd+F** searches the active Source or PDF pane. Source search handles literal LaTeX commands, live match counts, case/whole-word/regular-expression options and optional replacement with normal undo. Invalid expressions are reported. PDF search scans all pages, handles ligatures, whitespace and line hyphenation, and marks the exact selected text persistently while search is open. **Enter / Shift+Enter** moves forward/backward; **Escape** closes search. Case and whole-word options are available in both panes. PDF results are capped at 500 and source counts at 10,000, with `+` when more exist. Image-only PDF text needs OCR before it can be found.

## Honesty notes

- Reading and claim verification have limits: an excerpt is not a whole-paper read, PDF extraction does not interpret figures or image-only tables, and scanned PDFs need OCR/text or supplied passages. Long-paper claim checks use relevant excerpts and label that limitation. Source-reading notices expose gaps; they do not certify every generated statement as correct. When a Codex tool catalog changes, its native session is refreshed within the same BlattBot chat, carrying recent conversation text when available; the complete transcript stays visible.
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

### Hosting behind an authenticated reverse proxy

Build the frontend with `npm run build --workspace=web -- --base=/blattbot/` (or another absolute path prefix), then `npm run build --workspace=server`. All API requests, WebSockets, PDF workers, downloads and logos follow that base. The default build still runs at `/`.

Keep the server on loopback. A proxy must authenticate the owner on **every** HTTP request and WebSocket upgrade, reject foreign-origin writes, remove the prefix, and send the loopback Host header. It may inject the local bearer token server-side; in that case, handle `/api/bootstrap` at the proxy without exposing the token. Keep user data in `BLATTBOT_DATA_DIR` outside releases and select the installed, authenticated Codex CLI with `BLATTBOT_CODEX_EXECUTABLE`.

For unattended deployments, the authenticated local `/api/deployment` endpoint reports the running `BLATTBOT_REVISION` and whether work is idle. `POST /api/deployment/drain` with `{"drain":true}` pauses new writes for up to two minutes while active requests, agent turns and research tasks finish. Only replace/restart an idle instance. Release a cancelled drain with `{"drain":false}`. Keep these deployment endpoints local. Build and test a pinned GitHub commit before activation; failed health checks must restore the previous code release without replacing user data.
