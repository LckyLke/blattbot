# Changelog

## Unreleased

- Edit files and passages directly inside Proof with the full source editor, shared live drafts, autocomplete, undo, and save shortcuts. Saves refresh the review diff and visible PDF; approval and discard wait for unsaved drafts to be saved or reverted.
- Codex is the default background harness, using the installed CLI and its login. Includes streamed replies, resumable chats, images, questions, compile/citation tools, read-only modes, interruption, token usage, and one-shot helpers. Claude and OpenAI-compatible endpoints remain selectable.
- Settings checks Codex connectivity and offers its model catalog and reasoning efforts. Model picks now save to the active backend's own field; cached suggestions refresh after settings changes. New project overrides are scoped to their backend, and legacy Claude overrides do not leak into Codex.
- Settings has keyboard-navigable tabs, focus containment, announced save/error states, and a persistent save action while scrolling.
- Source-link navigation keeps the cursor readout in sync. PDF search shows a pending state for new queries and prevents old document text from entering a new document's search cache.
- Shared file tools reject symlink escapes and `.git` reads. Listings skip symlinks and tolerate disappearing files. Misconfigured helper calls no longer fall back to another provider.
- Added a real CLI protocol check (`npm run codex:check --workspace=server`) and automated Codex integration tests using a local mock process.

## 0.4.2 — 2026-09-02

### Browser sign-in under WSL
- Fixed: running BlattBot inside WSL, neither "Sign in from browser session" nor "Log in via browser" could find a session — the server is a Linux process, so it scanned the (empty) Linux browser profiles and looked for a Linux Chromium, while the browser you are logged in with is the Windows one. A pasted cookie was the only way in.
- "Sign in from browser session" now also reads the Windows browsers' cookie stores under `/mnt/<drive>/Users/<you>/AppData` (Firefox, Chrome, Chromium, Edge, Brave, Vivaldi), labelled e.g. "Firefox (Windows)". Firefox works out of the box. Chrome and Edge on Windows encrypt cookies with a key only the browser itself can unwrap (app-bound encryption) and lock the store while running, so a session there stays unreadable — the error now says which browser had a session it could not read, instead of a bare "nothing found".
- "Log in via browser" under WSL (no Linux Chromium, or no display) opens the login page in your Windows default browser and watches the Windows cookie stores until the session authenticates. Log in with Firefox on Windows for this to complete; the timeout message explains the Chrome/Edge limitation.
- The Windows cookie-key unwrap now loads `System.Security` before calling DPAPI (Windows PowerShell 5.1 does not preload it), memoizes the unwrapped key per profile, and the keyring secret on Linux/macOS is fetched only when an encrypted cookie for the host actually exists — and cached, so a locked wallet no longer costs seconds on every scan.
- `blattbot doctor` reports WSL and the Windows user profiles it can reach. `BLATTBOT_WSL=1|0` forces detection, `BLATTBOT_WSL_MNT` overrides the `/mnt` root.

## 0.4.1 — 2026-09-02

### Claude Fable 5.1
- The `fable` alias now resolves to `claude-fable-5-1`; `claude-fable-5-1` heads the model pick-lists (Claude Fable 5 stays selectable by id).
- The Claude Agent SDK is upgraded from 0.1.x to 0.3.x. Its CLI ships as a platform-specific native binary (an ~200 MB optional dependency npm picks for your OS) and knows the Claude 5 models: turns on Fable 5.1, Opus 5, and Sonnet 5 are now priced correctly (the January CLI billed unknown models at a default rate) and get their full 1M context instead of a 200K assumption. Requires zod 4.
- New **Effort** setting (Settings → Agent): low / medium / high / xhigh / max, passed to the SDK as the adaptive-thinking depth; empty keeps the model's default.
- New **Fallback model** setting. Empty means automatic: Opus 5 behind a Fable-family primary (none otherwise), so an overloaded Fable, or one whose safety classifiers decline a request, hands the turn over instead of failing it; `none` disables it. A decline is never silent: the chat shows which model declined (with the API's category and explanation when given) and where the turn continued, and the AI-use disclosure lists every model that actually served a turn.

### Source editor: unsaved edits are safe
- Text typed while a quick save (Ctrl+S) was still in flight was replaced by the saved copy when the save returned — the dirty flag was reset on the save result and the refetch then overwrote the editor. The editor now decides from its own text, never from a flag: a fetched copy only replaces a clean editor.
- Drafts survive a pane swap (picking Source in the other pane remounts the panel) and leaving and re-entering a project: they live outside the component tree, per project and file, and the last open file is restored. Switching files no longer demands a discard — the draft stays stashed, marked with a dot in the file tree — so a jump from the chat or the Proof view never costs you your edits.
- When the file on disk changes under a draft (an agent turn, a sync, a rejected hunk) the header says so; Save writes your version, Revert takes the disk version.
- The leave dialogs and the tab-close guard now know about unsaved editor drafts (a reload would lose them).

### Panes, drafts, and merges
- Picking the other pane's view swaps the two panes physically (CSS order) instead of moving panels between them, so no panel ever remounts: a half-typed chat message, the PDF scroll position, an editor selection all survive a swap.
- Drafts persist in the browser's storage (debounced), so a reload or a discarded tab does not lose them; the next time the file opens, the draft is restored — with the "changed on disk" notice if the file moved meanwhile.
- **Merge** button when the disk changed under a draft: a line-based three-way merge (base = what you typed over, yours, disk). Regions only one side touched merge silently; passages both changed differently become `<<<<<<< yours` / `>>>>>>> disk` blocks, the first one is revealed, and autosave stays off until they are resolved.
- **autosave** toggle in the editor footer (off by default): writes the file 1.5 s after you stop typing, never while the agent works. A save still changes the review diff and triggers a recompile when the PDF is visible, which is why it is opt-in.

### Transparency
- Rate-limit warnings, API retries, and context compaction now show as chat notices instead of an unexplained pause; each turn's line shows the context size against the model's window (e.g. `ctx 42.0k/1.0M`).
- A Fable safety decline shows a question card — retry on the fallback model (the rest of the chat continues there) or stop and rephrase — rather than a silent model swap.
- The model pick-lists (chat chip, Settings, project settings) come from the engine's own catalog: display names, descriptions, effort support, with BlattBot's tier aliases appended; the built-in list remains the fallback. One shared list instead of three copies.
- `blattbot doctor` and Settings → Transparency report the Agent SDK version and which engine binary runs; `BLATTBOT_CLAUDE_EXECUTABLE` points the SDK at another `claude` binary for people who would rather skip the bundled one.

### Fixes
- A fast turn could leave the composer locked on "Stop": the send path re-armed the busy state after the server's reply, even when the turn's end had already arrived over the websocket. It now checks that first.

### Browser sign-in (auto cookie import)
- Fixed: importing an Overleaf session from a Chromium-family browser (Chrome, Chromium, Brave, Edge) returned nothing whenever the browser held real cookies. The `last_access_utc` column is microseconds since 1601 (~1.3e16), past JavaScript's safe-integer limit, so the SQLite read threw and the importer silently skipped that browser. The timestamp is now read as a double.
- Fixed on KDE: Chromium stores its cookie-encryption secret in KWallet, which the importer never queried (it only asked the freedesktop Secret Service, which a stock KDE install does not populate for Chromium). It now falls back to `kwallet-query`; set `BLATTBOT_KWALLET` to override the wallet name. Together these two fixes are why "Sign in from browser session" found nothing and a cookie had to be pasted by hand.
- Note: "Log in via browser" opens a Chromium or Chrome window (via playwright-core) and does not use Firefox; "Sign in from browser session" reads Firefox and every Chromium-family store and launches nothing.

### Hardening
- The file fence (project-only writes, project-plus-context reads, credential stores off-limits) moved into a PreToolUse hook. Under the SDK's bypass permission mode ordinary tool calls never reached the permission callback that held it — verified live: a Write outside the project went through before and is refused now. Mid-turn questions keep using the callback.

### Codebase as context
- Link a whole folder — the paper's codebase, an experiment directory — through a folder browser in the sidebar instead of typing an absolute path. Directory names only; credential stores and BlattBot's own data are not browsable.
- Every turn now hands the agent a listing of what each linked path actually contains (file counts, extensions, tree), scanned at turn start rather than when you linked it, with vendored and build directories left out and named. A linked folder is read live; nothing is copied or snapshotted.
- The agent is instructed to use that material to *check* the manuscript — formulas, algorithms, hyperparameters, reported numbers, symbol names — to cite the evidence as `path:line`, and to report a disagreement between text and implementation rather than silently rewriting either. Edits inside linked paths remain blocked on both backends.

## 0.3.0 — 2026-07-31

### Images in chat
- Attach images to a chat message by pasting from the clipboard (screenshots), dragging them onto the composer, or picking files. Thumbnails appear in the composer and in your message; clicking one opens it full size. Oversized images are downscaled in the browser so a 4K screenshot or phone photo just works.
- Attachments are stored outside the project working tree, so they never appear in the review diff or reach Overleaf. Both backends receive them: image content blocks on the Claude backend, `image_url` blocks on OpenAI-compatible endpoints, with an automatic text-only retry (and a visible notice) for endpoints without vision.

### Understand mode
- New read-only chat mode for Q&A about the project's text, math, and arguments — especially a co-author's passages. Every answer quotes the passage and names the file, and labels what the text says vs. background knowledge vs. interpretation. File edits are blocked exactly as in Review mode, on both backends.

### Verified citations
- The audit checks arXiv preprints against arXiv itself (Crossref does not index the `10.48550` DOI namespace) and falls back to a title search across Semantic Scholar, DBLP, Crossref, and OpenAlex before calling any entry unresolved — correct references to preprints and ML-venue papers are no longer flagged as possibly fabricated. A `mismatch` from the identifier lookup is never softened by the fallback, and matching author+year alone no longer rubber-stamps an unrelated title.
- `add_citation` now verifies each new entry against Crossref/OpenAlex the moment it is written and reports the verdict to the agent, so a wrong reference surfaces during the turn rather than at review time.
- New `audit_citations` tool lets the agent re-check entries — required by the prompts for any BibTeX written by hand, the path where fabricated references originate.
- The audit no longer flags correct entries whose title Crossref splits across `title` and `subtitle` (e.g. "AMIE" + its subtitle); short and long title forms, and author+year corroboration, are accepted. Genuinely wrong DOIs are still flagged.
- Flagged entries in the References tab offer **fix** (hands the agent a precise repair request) and **ok** (records your judgement that the entry is sound; retired automatically if you later edit the entry).

### Chat rendering and navigation
- Chat messages render Markdown and LaTeX math (KaTeX) instead of printing raw `$…$`, with fonts bundled for offline use.
- References to `file.tex:42` in an answer become links that reveal and flash that line in the Source editor; quoted passages offer "find in source" and, when a PDF pane is open, "find in PDF".
- Read-only tools (search, read, literature lookup) show a one-line result summary under the chip, so tool activity is visibly working.
- Each Proof hunk shows its line range and an ↗ button that opens that line in the editor for manual tweaks.

### Find and quote
- The PDF panel gained a real find (Ctrl+F or the ⌕ button) that searches the whole document, not only the rendered pages, with match counts and next/previous.
- Selections in the Source editor can be quoted into the chat, labeled with their file and line; PDF selections spanning two pages can now be quoted (they were silently ignored before).

### Safety and hardening
- Credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, …) and BlattBot's own account/session files are blocked from every file tool through permission rules that are evaluated before any auto-allow, plus a path fence on tool calls and shell commands. See SECURITY.md for what this does and does not guarantee.
- Markdown images in agent output render as inert placeholders and never issue network requests, closing a zero-click exfiltration path for prompt-injected content.
- Leaving a project or closing the tab with unapproved changes now warns first.
- Missing static assets return a proper 404 instead of the app shell, which previously surfaced as a cryptic "failed to load module" error after an update.

## 0.2.0 — 2026-07-30

### Conflict-safe sync
- Approving a change now fetches a fresh Overleaf snapshot first and detects remote drift. Pushes that would overwrite remote edits are blocked with a per-file conflict list; you can discard your version per file or force the push, in which case the remote versions are backed up under `.git/blattbot/remote-backup/<timestamp>/`.
- Remote-only changes are absorbed into the local mirror as their own commit, both on sync and after a push. Syncing with a dirty working tree now merges the clean files and reports the overlap instead of skipping entirely.

### In-place Overleaf updates
- Edited documents are updated through Overleaf's realtime protocol (joinDoc/applyOtUpdate) instead of delete-and-reupload, so entity ids are preserved and comments, tracked changes, and per-document history survive a push. Automatic fallback to plain upload (with a warning) if the in-place update fails.

### Verify on Overleaf
- New button runs Overleaf's own compiler on the pushed remote state and shows that PDF next to the local build. The local compile is now labeled honestly as a preflight ("Local preflight (Tectonic)") since Overleaf's TeX Live can differ.

### Rendered PDF diff
- The Proof tab gained a visual diff: the pre-change and current PDFs are rendered and compared pixel-wise, with changed-page chips and highlighted changed regions — the latexdiff use case without Perl. Per-commit builds are cached and evicted LRU.

### Citation integrity
- Dedupe on add now matches by normalized DOI (including DOIs hidden in `url` fields) as well as title; duplicate keys get `-2`/`-3` suffixes.
- New entries are normalized: abstracts/keywords stripped, titles brace-protected, required-field warnings reported.
- arXiv references are upgraded to the published version's DOI via Crossref when a confident match exists.
- New deterministic citation audit checks every bibliography entry against Crossref/OpenAlex and badges it verified / unresolved / mismatch in the References tab, with evidence links.

### Cost transparency and disclosure
- Every turn shows its cost in USD (or token count on providers without pricing); projects show a running total. Both backends report usage.
- New AI-use disclosure generator composes a statement from the project's real usage logs (turns, modes, models, files touched) — for venue and institutional AI policies.

### Mid-turn questions
- The agent can now ask clarifying multiple-choice questions during a turn (the Claude SDK's AskUserQuestion tool; `ask_user` on the OpenAI-compatible backend) instead of guessing. The chat shows a question card with clickable options, a free-text "Other…" field, and a Skip action; the turn blocks until you answer, skip, or stop it, and reloading the page restores a still-pending card. Available in every mode, including read-only Review.

### Other
- Hardened system prompt: untrusted-content rules (file/context content is data, not instructions) and a no-fabricated-citations rule (citation tools only, from resolvable identifiers).
- Review mode rewritten as a venue-style referee-report rubric; file edits remain blocked in it.
- Update check against the npm registry with an update-available notice in the sidebar.
- Accessibility pass across the web UI.
- New SECURITY.md documenting the local server surface, credential storage, and what is sent where.

## 0.1.0

Initial release.
