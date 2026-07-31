import { useMemo, useState } from "react";
import { tabStripKeyDown } from "../a11y";
import { buildHunkPatch, parseDiff, type DiffFile, type DiffHunk } from "../diff";
import type { CompileInfo, SyncConflict } from "../api";
import { useDialog } from "./Dialog";
import { HunkLines } from "./DiffView";
import RenderedDiff from "./RenderedDiff";

interface Props {
  diff: string;
  busy: boolean;
  /** Approve was blocked: Overleaf changed these files while they also carry local edits. */
  conflicts: SyncConflict[] | null;
  projectId: string;
  /** Local build state (App-owned) — the rendered diff's "current" side. */
  compile: CompileInfo | null;
  compiling: boolean;
  pdfStamp: number;
  /** Ask App to recompile the working state when the preview is missing/stale. */
  onEnsureCurrentPdf: () => void;
  onApprove: (message: string, force?: boolean) => void | Promise<void>;
  onReject: () => void | Promise<void>;
  onRejectFile: (path: string) => void;
  onRejectHunk: (patch: string) => void;
  /** Drop the local edits to the conflicted paths (reject-file per path). */
  onDiscardConflicts: (paths: string[]) => void | Promise<void>;
}

export default function ProofPanel({
  diff,
  busy,
  conflicts,
  projectId,
  compile,
  compiling,
  pdfStamp,
  onEnsureCurrentPdf,
  onApprove,
  onReject,
  onRejectFile,
  onRejectHunk,
  onDiscardConflicts,
}: Props) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [message, setMessage] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** Source-level diff vs the compiled-output comparison. */
  const [mode, setMode] = useState<"text" | "rendered">("text");
  /** In-flight approve/discard — buttons lock and the footer shows a sweep. */
  const [acting, setActing] = useState<"push" | "discard" | null>(null);
  const dialog = useDialog();

  const totals = files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );

  async function approve(force = false) {
    if (acting) return;
    setActing("push");
    try {
      await onApprove(message.trim() || "BlattBot edit", force);
    } finally {
      setActing(null);
    }
  }

  /** Conflict banner: replace Overleaf's versions with ours, after a warning. */
  async function overwriteRemote() {
    if (acting) return;
    const ok = await dialog.confirm({
      title: "Overwrite Overleaf?",
      body: "Your versions of the conflicting files will replace the ones on Overleaf. Overleaf's current versions are backed up locally first.",
      confirmLabel: "Overwrite Overleaf",
      danger: true,
    });
    if (ok) await approve(true);
  }

  async function discard() {
    if (acting) return;
    setConfirmDiscard(false);
    setActing("discard");
    try {
      await onReject();
    } finally {
      setActing(null);
    }
  }

  /** Conflict banner: keep Overleaf's versions by dropping the local edits. */
  async function discardMine() {
    if (acting || !conflicts) return;
    setActing("discard");
    try {
      await onDiscardConflicts(conflicts.map((c) => c.path));
    } finally {
      setActing(null);
    }
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <p className="max-w-xs text-center font-serif text-sm leading-relaxed text-graphite">
          No pending changes. When BlattBot edits the project, the proof appears here for your
          review.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {conflicts && conflicts.length > 0 && (
        <div className="shrink-0 border-b border-gold/40 bg-gold/10 px-4 py-3">
          <p role="status" className="text-[12.5px] font-medium text-gold">
            Overleaf changed {conflicts.length} file{conflicts.length === 1 ? "" : "s"} you also
            edited — nothing was pushed
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-[11.5px] text-paper-dim">
            {conflicts.map((c) => (
              <li key={c.path}>
                {c.path}
                {c.kind === "deleted-remote" && (
                  <span className="ml-1.5 text-pencil">deleted on Overleaf</span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => void discardMine()}
              disabled={busy || acting !== null}
              className="rounded border border-rule px-2.5 py-1 text-[11.5px] text-paper-dim transition-colors hover:border-pencil hover:text-pencil disabled:opacity-50"
            >
              Discard my changes to these files
            </button>
            <button
              onClick={() => void overwriteRemote()}
              disabled={busy || acting !== null}
              className="rounded bg-pencil/90 px-2.5 py-1 text-[11.5px] font-medium text-ink transition-colors hover:bg-pencil disabled:opacity-50"
            >
              Overwrite Overleaf
            </button>
          </div>
        </div>
      )}
      {/* Text diff (source lines) vs rendered diff (compiled-output pixels). */}
      <div
        role="tablist"
        aria-label="Proof view"
        className="flex shrink-0 items-center gap-1.5 border-b border-rule px-4 py-1.5 text-xs"
      >
        <button
          role="tab"
          aria-selected={mode === "text"}
          tabIndex={mode === "text" ? 0 : -1}
          onKeyDown={tabStripKeyDown}
          onClick={() => setMode("text")}
          title="Line-by-line source diff of the pending changes"
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
            mode === "text"
              ? "border-gold bg-gold/10 text-gold"
              : "border-rule text-paper-dim hover:border-graphite hover:text-paper"
          }`}
        >
          Text diff
        </button>
        <button
          role="tab"
          aria-selected={mode === "rendered"}
          tabIndex={mode === "rendered" ? 0 : -1}
          onKeyDown={tabStripKeyDown}
          onClick={() => setMode("rendered")}
          title="Compare the compiled PDF of the approval base (HEAD) against the current working state — what actually changed in the output"
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
            mode === "rendered"
              ? "border-gold bg-gold/10 text-gold"
              : "border-rule text-paper-dim hover:border-graphite hover:text-paper"
          }`}
        >
          Rendered diff
        </button>
      </div>

      {mode === "rendered" ? (
        <div role="tabpanel" aria-label="Rendered diff" className="min-h-0 flex-1">
          <RenderedDiff
            projectId={projectId}
            compile={compile}
            compiling={compiling}
            pdfStamp={pdfStamp}
            onEnsureCurrent={onEnsureCurrentPdf}
          />
        </div>
      ) : (
        <div
          role="tabpanel"
          aria-label="Text diff"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
          {files.map((file) => (
            <FileDiff
              key={file.path}
              file={file}
              busy={busy}
              onRejectFile={onRejectFile}
              onRejectHunk={onRejectHunk}
            />
          ))}
        </div>
      )}

      <div className="booktabs relative shrink-0 bg-ink-2 px-4 py-3">
        {/* Pushing/discarding feedback: a slim gold sweep over the footer's rule. */}
        {acting !== null && <div className="compile-bar absolute inset-x-0 top-0 z-10 h-[3px]" />}
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="text-graphite">
            {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
            <span className="text-leaf">+{totals.add}</span>{" "}
            <span className="text-pencil">−{totals.del}</span>
          </span>
          {busy && <span className="text-gold">agent still working…</span>}
        </div>
        <div className="flex gap-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message (optional)"
            className="min-w-0 flex-1 rounded border border-rule bg-ink px-3 py-2 text-[13px] text-paper placeholder:text-graphite/60"
          />
          <button
            onClick={() => void approve()}
            disabled={busy || acting !== null}
            className="flex items-center gap-1.5 rounded bg-leaf-deep px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
          >
            {acting === "push" && (
              <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-paper" />
            )}
            {acting === "push" ? "Pushing…" : "Approve & push"}
          </button>
          {confirmDiscard ? (
            <button
              onClick={() => void discard()}
              disabled={busy || acting !== null}
              className="rounded bg-pencil/90 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-pencil disabled:opacity-50"
            >
              Really discard?
            </button>
          ) : (
            <button
              onClick={() => setConfirmDiscard(true)}
              disabled={busy || acting !== null}
              className="flex items-center gap-1.5 rounded border border-rule px-3 py-2 text-[13px] text-paper-dim transition-colors hover:border-pencil hover:text-pencil disabled:opacity-50"
            >
              {acting === "discard" && (
                <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-pencil" />
              )}
              {acting === "discard" ? "Discarding…" : "Discard"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<DiffFile["status"], { label: string; cls: string }> = {
  modified: { label: "edited", cls: "text-gold border-gold/40" },
  added: { label: "new", cls: "text-leaf border-leaf/40" },
  deleted: { label: "deleted", cls: "text-pencil border-pencil/40" },
  renamed: { label: "renamed", cls: "text-paper-dim border-rule" },
};

function FileDiff({
  file,
  busy,
  onRejectFile,
  onRejectHunk,
}: {
  file: DiffFile;
  busy: boolean;
  onRejectFile: (path: string) => void;
  onRejectHunk: (patch: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [confirmFile, setConfirmFile] = useState(false);
  const badge = STATUS_BADGE[file.status];
  return (
    <section className="mb-4">
      <div className="booktabs flex w-full items-baseline gap-2 px-1 pb-1 pt-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span className="truncate font-serif text-[14.5px] font-semibold text-paper">{file.path}</span>
          <span className={`rounded-sm border px-1 text-[11px] uppercase tracking-wide ${badge.cls}`}>
            {badge.label}
          </span>
          <span className="ml-auto font-mono text-[12px] text-graphite">
            <span className="text-leaf">+{file.additions}</span>{" "}
            <span className="text-pencil">−{file.deletions}</span>
          </span>
        </button>
        {confirmFile ? (
          <button
            onClick={() => {
              setConfirmFile(false);
              onRejectFile(file.path);
            }}
            disabled={busy}
            aria-label={`Really discard changes to ${file.path}?`}
            className="rounded bg-pencil/90 px-1.5 text-[11px] font-medium text-ink transition-colors hover:bg-pencil disabled:opacity-50"
          >
            really?
          </button>
        ) : (
          <button
            onClick={() => setConfirmFile(true)}
            disabled={busy}
            aria-label={`Discard changes to ${file.path}`}
            title={`Discard all changes to ${file.path}`}
            className="rounded border border-rule px-1.5 text-[11px] text-graphite transition-colors hover:border-pencil hover:text-pencil disabled:opacity-50"
          >
            discard file
          </button>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
          className="font-mono text-[12px] text-graphite"
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>
      {!collapsed &&
        file.hunks.map((hunk, hi) => (
          <HunkBlock key={hi} file={file} hunk={hunk} busy={busy} onRejectHunk={onRejectHunk} />
        ))}
    </section>
  );
}

function HunkBlock({
  file,
  hunk,
  busy,
  onRejectHunk,
}: {
  file: DiffFile;
  hunk: DiffHunk;
  busy: boolean;
  onRejectHunk: (patch: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="mt-1 overflow-x-auto rounded border border-rule bg-ink-2/60">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-0.5">
        <span className="min-w-0 truncate font-mono text-[11.5px] italic text-graphite">
          {hunk.header || hunk.rawHeader.replace(/^@@ | @@.*$/g, "")}
        </span>
        {confirm ? (
          <button
            onClick={() => {
              setConfirm(false);
              onRejectHunk(buildHunkPatch(file, hunk));
            }}
            disabled={busy}
            aria-label={`Really discard this change in ${file.path}?`}
            className="ml-auto shrink-0 rounded bg-pencil/90 px-1.5 text-[11px] font-medium text-ink transition-colors hover:bg-pencil disabled:opacity-50"
          >
            really?
          </button>
        ) : (
          <button
            onClick={() => setConfirm(true)}
            disabled={busy}
            aria-label={`Discard this change in ${file.path}`}
            title="discard this change"
            className="ml-auto shrink-0 rounded px-1 font-mono text-[12px] leading-none text-graphite transition-colors hover:text-pencil disabled:opacity-50"
          >
            ×
          </button>
        )}
      </div>
      <HunkLines hunk={hunk} />
    </div>
  );
}
