/**
 * The agent turn's lifecycle in the UI: the card a turn that changed files
 * ends with (Review · Show changes · Undo turn), the list of messages queued
 * behind the running turn, and the short-lived Undo toast after a discard or
 * an undo.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, type ChatMeta, type ChatQueue } from "../api";
import type { ChatItem } from "../chat-events";
import { parseDiff, type DiffFile } from "../diff";
import { useDialog } from "./Dialog";
import DiffView from "./DiffView";

/** What a turn card can do — provided by Chat, so the memoized bubbles keep their props. */
export interface TurnActions {
  projectId: string;
  busy: boolean;
  onReview?: () => void;
  onUndo?: (turnRef: string) => Promise<void>;
}

export const TurnActionsContext = createContext<TurnActions | null>(null);

const AFTER_TURN = "Available when the agent turn ends";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type TurnEndItem = Extract<ChatItem, { kind: "turn_end" }>;

export function TurnCard({ item }: { item: TurnEndItem }) {
  const actions = useContext(TurnActionsContext);
  const dialog = useDialog();
  const [shown, setShown] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const files = item.files ?? [];
  const count = item.fileCount ?? files.length;
  const turnRef = item.turnRef!;

  async function toggleChanges() {
    if (shown) {
      setShown(null);
      return;
    }
    if (!actions) return;
    setLoading(true);
    setError("");
    try {
      const r = await api.turnDiff(actions.projectId, turnRef);
      setShown(parseDiff(r.diff));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function undo() {
    if (!actions?.onUndo) return;
    const ok = await dialog.confirm({
      title: "Undo this turn?",
      body:
        `This reverses what the turn changed in ${plural(count, "file")}, in your files as they are now. ` +
        "Edits you made since are kept; where they overlap the turn's changes, both versions are kept with conflict markers for you to resolve. " +
        "Nothing is pushed — the result shows up in Proof, and you can undo the undo right after.",
      confirmLabel: "Undo turn",
      danger: true,
    });
    if (!ok) return;
    setUndoing(true);
    try {
      await actions.onUndo(turnRef);
    } finally {
      setUndoing(false);
    }
  }

  const busy = actions?.busy ?? false;
  const action =
    "rounded-lg border border-rule px-2 py-0.5 text-[11px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50";
  return (
    <div data-turn-card className="w-full rounded-lg border border-rule bg-ink-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]">
        <span className="text-paper-dim">
          {item.interrupted ? "Before stopping, the turn changed " : ""}
          {plural(count, "file")}
        </span>
        <span className="font-mono text-[11px]">
          <span className="text-leaf">+{item.additions ?? 0}</span>{" "}
          <span className="text-pencil">−{item.deletions ?? 0}</span>
        </span>
        {item.undone && (
          <span title={item.undone} className="rounded-sm border border-gold/40 px-1 text-[10px] uppercase tracking-wide text-gold">
            undone
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {actions?.onReview && (
            <button type="button" onClick={actions.onReview} className={action} title="Open Proof to review, approve or discard the pending changes">
              Review
            </button>
          )}
          <button type="button" onClick={() => void toggleChanges()} disabled={loading} aria-expanded={shown !== null} className={action}
            title="What this turn changed — read-only">
            {loading ? "Loading…" : shown ? "Hide changes" : "Show changes"}
          </button>
          {actions?.onUndo && !item.undone && (
            <button
              type="button"
              onClick={() => void undo()}
              disabled={busy || undoing}
              title={busy ? AFTER_TURN : "Reverse this turn's changes, keeping edits made since"}
              className="rounded-lg border border-rule px-2 py-0.5 text-[11px] text-paper-dim transition-colors hover:border-pencil hover:text-pencil disabled:opacity-50"
            >
              {undoing ? "Undoing…" : "Undo turn"}
            </button>
          )}
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-[10.5px] text-graphite" title={files.map((f) => f.path).join("\n")}>
        {files.slice(0, 4).map((f) => f.path).join(", ")}
        {count > 4 ? ` +${count - 4} more` : ""}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-pencil">
          {error}
        </p>
      )}
      {shown && (
        <div role="region" aria-label="Changes of this turn" className="mt-2 flex max-h-96 flex-col gap-2 overflow-y-auto">
          {shown.length === 0 && <p className="text-[11px] text-graphite">No text changes.</p>}
          {shown.map((file) => (
            <div key={file.path}>
              <div className="mb-0.5 font-mono text-[11px] text-paper-dim">
                {file.path}{" "}
                <span className="text-leaf">+{file.additions}</span> <span className="text-pencil">−{file.deletions}</span>
              </div>
              <DiffView file={file} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PAUSED: Record<NonNullable<ChatQueue["paused"]>, string> = {
  error: "the last turn ended with an error",
  interrupted: "the last turn was stopped",
};

/** Messages waiting for the running turn, under the composer. */
export function QueueList({
  queue,
  chats,
  activeChatId,
  busy,
  onRemove,
  onResume,
}: {
  queue: ChatQueue;
  chats: ChatMeta[];
  activeChatId: string | null;
  busy: boolean;
  onRemove?: (id: string) => void;
  onResume?: () => void;
}) {
  return (
    <section aria-label="Queued messages" className="mx-auto mt-2 max-w-2xl rounded-xl border border-rule/70 bg-ink-2/60 px-3 py-2 text-[12px]">
      {queue.paused ? (
        <div className="mb-1 flex flex-wrap items-center gap-2 text-gold">
          <span role="status" title={`Nothing starts on its own: ${PAUSED[queue.paused]}.`}>
            Queue paused · {PAUSED[queue.paused]}
          </span>
          {onResume && (
            <button
              type="button"
              onClick={onResume}
              className="rounded-lg border border-gold/50 px-2 py-0.5 text-[11px] text-gold transition-colors hover:bg-gold/10"
            >
              Resume
            </button>
          )}
        </div>
      ) : (
        <p className="mb-1 text-[11px] text-graphite">
          {busy ? "Queued — each starts when the turn before it ends" : "Starting the next queued message…"}
        </p>
      )}
      <ol className="flex flex-col gap-1">
        {queue.items.map((item, i) => {
          const elsewhere = item.chatId !== activeChatId ? chats.find((c) => c.id === item.chatId)?.title ?? "another chat" : null;
          const label = item.text || (item.images ? plural(item.images, "image") : "message");
          return (
            <li key={item.id} className="flex items-center gap-2">
              <span className="font-mono text-[10.5px] text-graphite">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-paper-dim" title={item.text}>
                {label}
              </span>
              {item.images > 0 && item.text && <span className="shrink-0 text-[10.5px] text-graphite">+{plural(item.images, "image")}</span>}
              {elsewhere && <span className="shrink-0 text-[10.5px] text-graphite">in {elsewhere}</span>}
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove queued message ${i + 1}`}
                  title="Remove from the queue"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-graphite transition-colors hover:bg-white/5 hover:text-pencil"
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export interface UndoToastState {
  /** A new key restarts the timer. */
  key: number;
  text: string;
  /** Undo what was just done; resolves when finished. */
  onUndo: () => Promise<void>;
}

/** How long the Undo toast stays. */
export const UNDO_TOAST_MS = 15_000;

export function UndoToast({ toast, onClose }: { toast: UndoToastState | null; onClose: () => void }) {
  const [running, setRunning] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!toast) return;
    setRunning(false);
    const timer = setTimeout(() => closeRef.current(), UNDO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      role="status"
      aria-label="Undo"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-rule bg-ink-3 px-4 py-2 text-[13px] text-paper shadow-[0_8px_30px_rgb(0_0_0/0.35)]"
    >
      <span>{toast.text}</span>
      <button
        type="button"
        disabled={running}
        onClick={async () => {
          setRunning(true);
          try {
            await toast.onUndo();
          } finally {
            closeRef.current();
          }
        }}
        className="rounded-lg border border-leaf/60 px-2.5 py-0.5 text-[12px] font-medium text-leaf transition-colors hover:bg-leaf/10 disabled:opacity-50"
      >
        {running ? "Undoing…" : "Undo"}
      </button>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="text-graphite hover:text-paper">
        ×
      </button>
    </div>
  );
}
