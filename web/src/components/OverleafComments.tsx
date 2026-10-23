import { useCallback, useEffect, useRef, useState } from "react";
import { reviewApi, type OverleafReview, type ReviewThread } from "../overleaf-review";

interface Props {
  projectId: string;
  /** Changes when the working tree may have changed: re-reads local lines and stale flags. */
  stamp: number;
  /** Local files; a comment on a file that is not here cannot be opened. */
  files: string[];
  /** Open `path` at `line` in the Source editor. */
  onJump: (path: string, line: number) => void;
}

function when(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The Source pane's "Comments" button and its list of Overleaf review
 * comments: co-authors' threads with the quoted passage, location, latest
 * messages, a jump to the line, and reply / resolve / reopen (the user's own
 * actions — the agent can only read comments). Comments whose quoted text is
 * no longer in the local file are marked.
 */
export default function OverleafComments({ projectId, stamp, files, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<OverleafReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const next = await reviewApi.comments(projectId, refresh);
        if (mine !== seq.current) return;
        setReview(next);
        setError(null);
      } catch (err: any) {
        if (mine === seq.current) setError(String(err?.message ?? err));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [projectId],
  );

  // The count shows on the button, so load once per project and after tree changes.
  useEffect(() => {
    setReview(null);
    setError(null);
  }, [projectId]);
  useEffect(() => {
    void load(false);
  }, [load, stamp]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const openThreads = review?.threads.filter((t) => !t.resolved) ?? [];
  const resolvedThreads = review?.threads.filter((t) => t.resolved) ?? [];
  const shown = showResolved ? review?.threads ?? [] : openThreads;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Overleaf comments${review ? ` (${openThreads.length} open)` : ""}`}
        title={error ?? "Co-authors' review comments on Overleaf"}
        className={`flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11.5px] transition-colors ${
          open ? "border-leaf/60 text-leaf" : "border-rule text-paper-dim hover:border-leaf/40 hover:text-paper"
        }`}
      >
        Comments
        {review && (
          <span
            data-comment-count
            className={`rounded-full px-1.5 text-[10px] leading-4 ${openThreads.length > 0 ? "bg-gold/20 text-gold" : "bg-ink-3 text-graphite"}`}
          >
            {openThreads.length}
          </span>
        )}
        {!review && error && <span className="text-pencil">!</span>}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Overleaf comments"
          className="absolute right-0 top-full z-30 mt-1 flex max-h-[70vh] w-[400px] max-w-[85vw] flex-col rounded-xl border border-rule bg-ink-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        >
          <header className="flex items-center gap-2 border-b border-rule px-3 py-2">
            <h3 className="font-sans text-[13px] font-semibold text-paper">Overleaf comments</h3>
            <span className="text-[11px] text-graphite">
              {review ? `${openThreads.length} open${resolvedThreads.length ? ` · ${resolvedThreads.length} resolved` : ""}` : ""}
            </span>
            <button
              onClick={() => void load(true)}
              disabled={loading}
              className="ml-auto rounded-lg border border-rule px-2 py-0.5 text-[11px] text-paper-dim transition-colors hover:border-leaf/40 hover:text-paper disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {error && (
              <p role="alert" className="mb-2 text-[12px] leading-snug text-pencil">
                Could not load the Overleaf comments: {error}
              </p>
            )}
            {review?.warnings.map((w) => (
              <p key={w} className="mb-2 text-[11px] leading-snug text-gold">
                {w}
              </p>
            ))}
            {review && shown.length === 0 && (
              <p className="py-3 text-center text-[12px] text-graphite">
                {openThreads.length === 0 && resolvedThreads.length > 0 ? "No open comments." : "No comments on Overleaf."}
              </p>
            )}
            {!review && !error && <p className="py-3 text-center text-[12px] text-graphite">Loading…</p>}
            <ul className="space-y-2">
              {shown.map((t) => (
                <ThreadItem
                  key={t.id}
                  projectId={projectId}
                  thread={t}
                  canOpen={files.includes(t.path)}
                  onJump={(path, line) => {
                    onJump(path, line);
                    setOpen(false);
                  }}
                  onReview={setReview}
                />
              ))}
            </ul>
            {resolvedThreads.length > 0 && (
              <button
                onClick={() => setShowResolved((s) => !s)}
                className="mt-2 text-[11px] text-graphite underline-offset-2 hover:text-paper hover:underline"
              >
                {showResolved ? "Hide resolved" : `Show resolved (${resolvedThreads.length})`}
              </button>
            )}
            {review && review.changes.length > 0 && (
              <details className="mt-3 border-t border-rule pt-2">
                <summary className="cursor-pointer text-[11.5px] text-paper-dim">
                  {review.changes.length} tracked change{review.changes.length === 1 ? "" : "s"} on Overleaf
                </summary>
                <ul className="mt-1 space-y-1">
                  {review.changes.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => {
                          onJump(c.path, c.line);
                          setOpen(false);
                        }}
                        disabled={!files.includes(c.path)}
                        className="w-full rounded px-1 py-0.5 text-left text-[11px] leading-snug text-paper-dim hover:bg-ink-3 disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span className={c.kind === "insert" ? "text-leaf" : "text-pencil line-through"}>{clip(c.text, 80)}</span>{" "}
                        <span className="text-graphite">
                          {c.kind === "insert" ? "inserted" : "deleted"}
                          {c.author ? ` by ${c.author}` : ""} · {c.path}:{c.line}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadItem({
  projectId,
  thread,
  canOpen,
  onJump,
  onReview,
}: {
  projectId: string;
  thread: ReviewThread;
  canOpen: boolean;
  onJump: (path: string, line: number) => void;
  onReview: (review: OverleafReview) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = thread.localLine ?? thread.line;
  const messages = expanded ? thread.messages : thread.messages.slice(-2);

  async function run(action: () => Promise<OverleafReview>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      onReview(await action());
      after?.();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-thread-id={thread.id} className={`rounded-lg border px-2.5 py-2 ${thread.resolved ? "border-rule/60 opacity-75" : "border-rule"}`}>
      <button
        onClick={() => onJump(thread.path, line)}
        disabled={!canOpen}
        title={canOpen ? `Open ${thread.path} at line ${line}` : `${thread.path} is not in the local copy`}
        className="block w-full text-left disabled:cursor-default"
      >
        <span className="block border-l-2 border-gold/60 pl-2 font-serif text-[12.5px] italic leading-snug text-paper">
          {thread.quote ? clip(thread.quote, 160) : "(no quoted text)"}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-graphite">
          <span className={canOpen ? "text-leaf" : ""}>
            {thread.path}:{line}
          </span>
          {thread.stale && (
            <span
              className="rounded border border-pencil/40 px-1 font-sans text-[10px] text-pencil"
              title="The quoted text is no longer in your local copy of this file — it was edited here since the comment was made."
            >
              changed locally
            </span>
          )}
          {thread.resolved && <span className="rounded border border-rule px-1 font-sans text-[10px]">resolved</span>}
        </span>
      </button>

      {thread.messages.length > 2 && (
        <button onClick={() => setExpanded((e) => !e)} className="mt-1 text-[10.5px] text-graphite hover:text-paper">
          {expanded ? "Show latest only" : `Show all ${thread.messages.length} messages`}
        </button>
      )}
      <ul className="mt-1 space-y-1">
        {messages.map((m) => (
          <li key={m.id || `${m.author}-${m.time}`} className="text-[11.5px] leading-snug">
            <span className="font-medium text-paper-dim">{m.author}</span>
            {m.time && <span className="ml-1.5 text-[10px] text-graphite">{when(m.time)}</span>}
            <p className="whitespace-pre-wrap break-words text-paper">{m.content}</p>
          </li>
        ))}
      </ul>

      {replying && (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            autoFocus
            aria-label="Reply to this comment"
            placeholder="Reply on Overleaf…"
            className="w-full resize-y rounded-lg border border-rule bg-ink px-2 py-1 text-[12px] text-paper placeholder:text-graphite/60"
          />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-[11px] leading-snug text-pencil">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        {replying ? (
          <>
            <button
              onClick={() =>
                void run(() => reviewApi.reply(projectId, thread.id, draft), () => {
                  setDraft("");
                  setReplying(false);
                })
              }
              disabled={busy || !draft.trim()}
              className="rounded-lg bg-leaf-deep px-2 py-0.5 text-[11px] font-medium text-paper hover:bg-leaf disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send reply"}
            </button>
            <button onClick={() => setReplying(false)} disabled={busy} className="rounded-lg px-2 py-0.5 text-[11px] text-graphite hover:text-paper">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setReplying(true)}
              className="rounded-lg border border-rule px-2 py-0.5 text-[11px] text-paper-dim hover:border-leaf/40 hover:text-paper"
            >
              Reply
            </button>
            <button
              onClick={() => void run(() => reviewApi.setResolved(projectId, thread.id, !thread.resolved))}
              disabled={busy}
              className="rounded-lg border border-rule px-2 py-0.5 text-[11px] text-paper-dim hover:border-leaf/40 hover:text-paper disabled:opacity-50"
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
