import { useEffect, useMemo, useState } from "react";
import {
  api,
  type CommitKind,
  type HistoryBackup,
  type HistoryCommit,
  type HistoryFilter,
  type Project,
  type RevertResult,
} from "../api";
import { tabStripKeyDown } from "../a11y";
import { parseDiff, type DiffFile } from "../diff";
import {
  HISTORY_FILTERS,
  changeSummary,
  filterLabel,
  groupByDay,
  kindLabel,
  newIncoming,
  timeOfDay,
} from "../history";
import { HunkLines } from "./DiffView";
import { hunkRange } from "./ProofPanel";
import { useDialog } from "./Dialog";

interface Props {
  projectId: string;
  projectKind: Project["kind"];
  /** Changes whenever the history may have moved (sync, approve, turn end). */
  stamp: number;
  visible: boolean;
  /** An agent turn runs: reverting waits. */
  busy: boolean;
  /** The newest commit seen before History was opened — newer incoming ones are marked new. */
  seenSha: string | null;
  /** A revert landed as pending changes. */
  onReverted: (projectId: string, result: RevertResult) => void;
}

const PAGE = 30;

const KIND_STYLE: Record<CommitKind, string> = {
  sync: "text-leaf border-leaf/40",
  approve: "text-gold border-gold/40",
  local: "text-paper-dim border-rule",
  revert: "text-pencil border-pencil/40",
  other: "text-graphite border-rule",
};

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  modified: "edited",
  added: "new",
  deleted: "deleted",
  renamed: "renamed",
};

interface ListState {
  head: string | null;
  commits: HistoryCommit[];
  nextOffset: number | null;
  /** Which filter + refresh the list belongs to. */
  key: string;
}

interface Detail {
  files?: DiffFile[];
  truncated?: boolean;
  error?: string;
}

interface Outcome {
  tone: "ok" | "warn" | "error";
  text: string;
  items?: string[];
}

function emptyText(filter: HistoryFilter, projectKind: Project["kind"]): string {
  if (filter === "sync") return projectKind === "git" ? "No commits from the remote yet." : "No changes from Overleaf yet.";
  if (filter === "mine") return projectKind === "local" ? "Nothing committed yet." : "Nothing pushed yet.";
  return "No history yet.";
}

function revertOutcome(r: RevertResult): Outcome {
  const items = r.conflicts.map((c) => `${c.path}: ${c.reason}`);
  if (r.changed.length === 0) {
    return items.length > 0
      ? { tone: "warn", text: "Nothing could be reverted automatically:", items }
      : { tone: "ok", text: "Nothing to revert — your files already match the state before this commit." };
  }
  return {
    tone: items.length > 0 ? "warn" : "ok",
    text: `Reverted as pending changes to ${r.changed.join(", ")} — review and approve them in Proof.${
      items.length > 0 ? " Needs attention:" : ""
    }`,
    items,
  };
}

export default function HistoryPanel({ projectId, projectKind, stamp, visible, busy, seenSha, onReverted }: Props) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [list, setList] = useState<ListState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<HistoryBackup[]>([]);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [reverting, setReverting] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [reloads, setReloads] = useState(0);
  const dialog = useDialog();
  const key = `${filter}:${stamp}:${reloads}`;

  // (Re)load while visible: on open, on a filter change, when the history moved.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .history(projectId, { limit: PAGE, filter })
      .then((page) => {
        if (!cancelled) setList({ head: page.head, commits: page.commits, nextOffset: page.nextOffset, key });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Could not load the history: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    if (projectKind !== "local") {
      api
        .historyBackups(projectId)
        .then((r) => {
          if (cancelled) return;
          setBackups(r.backups);
          setBackupError(null);
        })
        .catch((err: Error) => {
          if (!cancelled) setBackupError(`Could not list the Overleaf backups: ${err.message}`);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [visible, projectId, projectKind, filter, key]);

  async function loadMore() {
    const current = list;
    if (!current || current.nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.history(projectId, {
        limit: PAGE,
        filter,
        head: current.head ?? undefined,
        offset: current.nextOffset,
      });
      setList((prev) => {
        if (!prev || prev.key !== current.key) return prev;
        const known = new Set(prev.commits.map((c) => c.sha));
        return { ...prev, commits: [...prev.commits, ...page.commits.filter((c) => !known.has(c.sha))], nextOffset: page.nextOffset };
      });
    } catch (err: any) {
      setError(`Could not load older commits: ${err.message}`);
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggle(commit: HistoryCommit) {
    if (open === commit.sha) {
      setOpen(null);
      return;
    }
    setOpen(commit.sha);
    if (details[commit.sha]?.files) return;
    setDetails((d) => ({ ...d, [commit.sha]: {} }));
    try {
      const r = await api.historyCommit(projectId, commit.sha);
      setDetails((d) => ({ ...d, [commit.sha]: { files: parseDiff(r.diff), truncated: r.truncated } }));
    } catch (err: any) {
      setDetails((d) => ({ ...d, [commit.sha]: { error: `Could not load this commit: ${err.message}` } }));
    }
  }

  async function revert(commit: HistoryCommit) {
    if (busy || reverting) return;
    const ok = await dialog.confirm({
      title: `Revert ${commit.short}?`,
      body:
        `BlattBot writes the reverse of "${commit.subject}" into your files as pending changes, keeping edits made since. ` +
        "Nothing is pushed: review the result in Proof and approve it like any other change.",
      confirmLabel: "Revert as pending changes",
    });
    if (!ok) return;
    setReverting(commit.sha);
    try {
      const result = await api.revertCommit(projectId, commit.sha);
      setOutcomes((o) => ({ ...o, [commit.sha]: revertOutcome(result) }));
      onReverted(projectId, result);
    } catch (err: any) {
      setOutcomes((o) => ({ ...o, [commit.sha]: { tone: "error", text: err.message } }));
    } finally {
      setReverting(null);
    }
  }

  const commits = list?.commits ?? [];
  const groups = useMemo(() => groupByDay(commits), [commits]);
  const fresh = useMemo(() => newIncoming(commits, seenSha), [commits, seenSha]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-rule px-4 py-1.5 text-xs">
        <div role="tablist" aria-label="History filter" className="flex items-center gap-1.5">
          {HISTORY_FILTERS.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              tabIndex={filter === f ? 0 : -1}
              onKeyDown={tabStripKeyDown}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                filter === f
                  ? "border-gold bg-gold/10 text-gold"
                  : "border-rule text-paper-dim hover:border-graphite hover:text-paper"
              }`}
            >
              {filterLabel(f, projectKind)}
            </button>
          ))}
        </div>
        <button
          onClick={() => setReloads((n) => n + 1)}
          disabled={loading}
          className="ml-auto rounded-lg border border-rule px-2 py-0.5 text-[11px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error && (
          <p role="alert" className="mb-3 rounded-lg border border-pencil/40 px-3 py-2 text-[12px] text-pencil">
            {error}
          </p>
        )}
        {!list && loading && (
          <p role="status" className="py-6 text-center font-sans text-[12px] text-graphite">
            Loading the history…
          </p>
        )}
        {list && commits.length === 0 && !loading && (
          <p className="py-6 text-center font-sans text-sm text-graphite">{emptyText(filter, projectKind)}</p>
        )}

        {groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="mb-3">
            <h3 className="booktabs mb-1 px-1 pb-1 font-sans text-[11px] font-semibold uppercase tracking-wide text-graphite">
              {group.label}
            </h3>
            <ol>
              {group.commits.map((commit) => (
                <CommitEntry
                  key={commit.sha}
                  commit={commit}
                  projectKind={projectKind}
                  isNew={fresh.has(commit.sha)}
                  isOpen={open === commit.sha}
                  detail={details[commit.sha]}
                  busy={busy}
                  reverting={reverting === commit.sha}
                  revertLocked={reverting !== null}
                  outcome={outcomes[commit.sha]}
                  onToggle={() => void toggle(commit)}
                  onRevert={() => void revert(commit)}
                />
              ))}
            </ol>
          </section>
        ))}

        {list?.nextOffset != null && (
          <div className="mb-4 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="rounded-lg border border-rule px-3 py-1 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load older commits"}
            </button>
          </div>
        )}

        {(backups.length > 0 || backupError) && (
          <section aria-label="Overleaf backups" className="mt-4 rounded-lg border border-rule bg-ink-2/60 px-3 py-2">
            <h3 className="font-sans text-[12.5px] font-semibold text-paper">Overleaf backups</h3>
            <p className="mb-2 text-[11.5px] leading-relaxed text-graphite">
              Overleaf's versions of files you chose to overwrite ("Overwrite Overleaf") are kept here, in the
              project's .git folder.
            </p>
            {backupError && (
              <p role="alert" className="text-[12px] text-pencil">
                {backupError}
              </p>
            )}
            {backups.map((b) => (
              <div key={b.stamp} className="mb-2 last:mb-0">
                <p className="font-mono text-[11px] text-graphite">
                  <time dateTime={b.at}>{new Date(b.at).toLocaleString()}</time>
                </p>
                <ul className="mt-0.5 space-y-0.5">
                  {b.files.map((f) => (
                    <li key={f.path} className="flex items-baseline gap-2 font-mono text-[12px] text-paper-dim">
                      <span className="min-w-0 truncate">{f.path}</span>
                      <a
                        href={api.backupFileUrl(projectId, b.stamp, f.path)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`View the backup of ${f.path}`}
                        className="ml-auto shrink-0 font-sans text-[11px] text-leaf underline decoration-leaf/40 underline-offset-2 hover:decoration-leaf"
                      >
                        View
                      </a>
                      <a
                        href={api.backupFileUrl(projectId, b.stamp, f.path, true)}
                        download
                        aria-label={`Download the backup of ${f.path}`}
                        className="shrink-0 font-sans text-[11px] text-leaf underline decoration-leaf/40 underline-offset-2 hover:decoration-leaf"
                      >
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function CommitEntry({
  commit,
  projectKind,
  isNew,
  isOpen,
  detail,
  busy,
  reverting,
  revertLocked,
  outcome,
  onToggle,
  onRevert,
}: {
  commit: HistoryCommit;
  projectKind: Project["kind"];
  isNew: boolean;
  isOpen: boolean;
  detail?: Detail;
  busy: boolean;
  reverting: boolean;
  revertLocked: boolean;
  outcome?: Outcome;
  onToggle: () => void;
  onRevert: () => void;
}) {
  const panelId = `history-commit-${commit.sha}`;
  const canRevert = commit.parents.length === 1;
  return (
    <li className="border-b border-rule/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="flex w-full items-start gap-2 rounded-lg px-1 py-2 text-left transition-colors hover:bg-ink-2/60"
      >
        <span
          className={`mt-0.5 shrink-0 rounded-sm border px-1 text-[10.5px] uppercase tracking-wide ${KIND_STYLE[commit.kind]}`}
        >
          {kindLabel(commit.kind, projectKind)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-paper">{commit.subject}</span>
          <span className="block truncate font-mono text-[11px] text-graphite">
            {commit.author.name} · {changeSummary(commit)} · {commit.short}
          </span>
        </span>
        {isNew && (
          <span className="mt-1 shrink-0 rounded-full bg-leaf px-1.5 text-[10px] font-medium leading-[16px] text-ink">
            new
          </span>
        )}
        <time dateTime={commit.time} className="mt-0.5 shrink-0 font-mono text-[11px] text-graphite">
          {timeOfDay(commit.time)}
        </time>
      </button>
      {isOpen && (
        <div id={panelId} className="pb-3 pl-1">
          {commit.body && <p className="mb-2 whitespace-pre-wrap text-[12px] leading-relaxed text-paper-dim">{commit.body}</p>}
          <p className="mb-2 break-all font-mono text-[11px] text-graphite">
            {commit.author.name} &lt;{commit.author.email}&gt; · {new Date(commit.time).toLocaleString()} ·{" "}
            {commit.sha.slice(0, 12)}
          </p>
          {detail?.error && (
            <p role="alert" className="text-[12px] text-pencil">
              {detail.error}
            </p>
          )}
          {!detail?.error && !detail?.files && (
            <p role="status" className="text-[12px] text-graphite">
              Loading the changes…
            </p>
          )}
          {detail?.files?.length === 0 && <p className="text-[12px] text-graphite">No file changes in this commit.</p>}
          {detail?.files?.map((file) => (
            <div key={`${file.oldPath ?? ""}:${file.path}`} className="mb-3" data-selection-location={`${file.path} (history)`}>
              <div className="flex items-baseline gap-2 px-1 pb-1">
                <span className="min-w-0 truncate font-sans text-[13px] font-semibold text-paper">
                  {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
                <span className="rounded-sm border border-rule px-1 text-[10.5px] uppercase tracking-wide text-paper-dim">
                  {STATUS_LABEL[file.status]}
                </span>
                <span className="ml-auto font-mono text-[11.5px] text-graphite">
                  <span className="text-leaf">+{file.additions}</span> <span className="text-pencil">−{file.deletions}</span>
                </span>
              </div>
              {file.hunks.length > 0 ? (
                file.hunks.map((hunk, hi) => (
                  <div key={hi} className="mt-1 overflow-hidden rounded-lg border border-rule bg-ink-2/60">
                    <div className="border-b border-rule px-3 py-0.5 font-mono text-[11px] text-graphite/80">{hunkRange(hunk)}</div>
                    <div className="overflow-x-auto">
                      <HunkLines hunk={hunk} />
                    </div>
                  </div>
                ))
              ) : (
                <p className="px-1 text-[11.5px] text-graphite">No text changes to show (binary file or rename only).</p>
              )}
            </div>
          ))}
          {detail?.truncated && (
            <p className="mb-2 text-[11.5px] text-gold">This commit is too large to show in full; the rest is left out.</p>
          )}
          {canRevert ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                onClick={onRevert}
                disabled={busy || revertLocked}
                title={
                  busy
                    ? "Wait for the agent turn to finish"
                    : "Write the reverse of this commit into your files as pending changes for Proof"
                }
                aria-label={`Revert ${commit.short}`}
                className="flex items-center gap-1.5 rounded-lg border border-rule px-2.5 py-1 text-[12px] text-paper-dim transition-colors hover:border-pencil hover:text-pencil disabled:opacity-50"
              >
                {reverting && <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-pencil" />}
                {reverting ? "Reverting…" : "Revert…"}
              </button>
              <span className="text-[11px] text-graphite">Becomes pending changes in Proof — nothing is pushed until you approve.</span>
            </div>
          ) : (
            commit.parents.length > 1 && (
              <p className="text-[11.5px] text-graphite">Merge commits can't be reverted here — revert the commits it merged instead.</p>
            )
          )}
          {outcome && (
            <div
              role={outcome.tone === "error" ? "alert" : "status"}
              className={`mt-2 rounded-lg border px-3 py-2 text-[12px] ${
                outcome.tone === "error"
                  ? "border-pencil/40 text-pencil"
                  : outcome.tone === "warn"
                    ? "border-gold/40 text-gold"
                    : "border-leaf/40 text-leaf"
              }`}
            >
              <p>{outcome.text}</p>
              {outcome.items && outcome.items.length > 0 && (
                <ul className="mt-1 list-disc pl-4 font-mono text-[11.5px]">
                  {outcome.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
