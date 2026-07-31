# Changelog

## 0.3.0 — 2026-07-31

### Images in chat
- Attach images to a chat message by pasting from the clipboard (screenshots), dragging them onto the composer, or picking files. Thumbnails appear in the composer and in your message; clicking one opens it full size. Oversized images are downscaled in the browser so a 4K screenshot or phone photo just works.
- Attachments are stored outside the project working tree, so they never appear in the review diff or reach Overleaf. Both backends receive them: image content blocks on the Claude backend, `image_url` blocks on OpenAI-compatible endpoints, with an automatic text-only retry (and a visible notice) for endpoints without vision.

### Understand mode
- New read-only chat mode for Q&A about the project's text, math, and arguments — especially a co-author's passages. Every answer quotes the passage and names the file, and labels what the text says vs. background knowledge vs. interpretation. File edits are blocked exactly as in Review mode, on both backends.

### Verified citations
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
