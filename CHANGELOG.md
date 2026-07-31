# Changelog

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
