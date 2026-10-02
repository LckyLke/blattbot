/**
 * The one mapping from chat events to chat items. The live websocket handler
 * (App's handleEvent) and the transcript replay (replayChatEvents) both fold
 * events through applyChatEvent, so a restored chat renders exactly what the
 * live view showed. Live-only side effects (busy state, compiles, the diff)
 * stay in handleEvent; this module is pure.
 *
 * Events arrive as untrusted JSON (websocket frames, persisted .jsonl lines),
 * so every field is checked before it reaches an item.
 */
import type { AgentQuestion, ChatTranscriptEvent, Project } from "./api.js";
import { appendChatItem } from "./citation-notices.js";

/** An image the user attached to a message, as the transcript records it. */
export interface ChatAttachment {
  id: string;
  mime: string;
}

/** What one chat entry shows, without its list identity (see ChatItem). */
export type ChatItemData =
  | { kind: "user"; text: string; scope?: string[]; images?: ChatAttachment[] }
  | { kind: "agent"; text: string; streaming: boolean }
  | {
      kind: "tool";
      id?: string;
      name: string;
      detail: string;
      status: "running" | "done" | "error";
      /** Unified diff of the file this edit touched — expandable under the chip. */
      fileDiff?: string;
      /** One-line result summary of a read-only tool (Grep/Read/search…). */
      resultHead?: string;
      input?: string;
      output?: string;
    }
  | { kind: "notice"; tone: "info" | "warn" | "error" | "ok"; text: string; citationGroup?: string; details?: string }
  | {
      /** A mid-turn agent question — actionable while pending, collapsed after.
       *  "stale": restored from a transcript with no resolution but not the
       *  turn-state's pending question either — likely still waiting server-side
       *  (reload to answer), so it must not claim the user skipped it. */
      kind: "question";
      questionId: string;
      questions: AgentQuestion[];
      status: "pending" | "answered" | "dismissed" | "stale";
      /** Question text → chosen answer (present once answered). */
      answers?: Record<string, string>;
    }
  | {
      kind: "turn_end";
      costUsd?: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      /** Size of the largest request this turn (≈ the conversation) and the model's window. */
      contextTokens?: number;
      contextWindow?: number;
    };

/**
 * A chat entry plus `uid`, its stable list identity (the React key). Per-item
 * UI state — an expanded tool chip, a half-answered question card — follows
 * the uid, so it never jumps to a neighbour when the list changes.
 */
export type ChatItem = ChatItemData & { uid: string };

export interface ApplyOptions {
  /** Identity for an item this event creates (extra items get a suffix). */
  uid: string;
  /** The open project's kind — words the approval notice. */
  projectKind?: Project["kind"];
}

const TONES = ["info", "warn", "error", "ok"] as const;
type Tone = (typeof TONES)[number];

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * A question card's identity is its question id — the same in the live
 * event and the restored transcript, so a card half-filled while a restore
 * lands keeps its picks.
 */
const questionUid = (questionId: string, fallback: string) => (questionId ? `q:${questionId}` : fallback);

/** Index of the last item matching `test`, or -1. */
function findLast(items: ChatItem[], test: (it: ChatItem) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
  return -1;
}

function replaceAt(items: ChatItem[], i: number, item: ChatItem): ChatItem[] {
  const next = items.slice();
  next[i] = item;
  return next;
}

function notice(uid: string, tone: Tone, text: string, extra?: { citationGroup?: string; details?: string }): ChatItem {
  return { uid, kind: "notice", tone, text, ...extra };
}

/**
 * Fold one event into the chat. Returns `items` itself (same reference) when
 * the event does not touch the chat, so a state setter can bail out.
 */
export function applyChatEvent(items: ChatItem[], ev: ChatTranscriptEvent, opts: ApplyOptions): ChatItem[] {
  const { uid } = opts;
  switch (ev?.type) {
    case "user_message": {
      const scope = Array.isArray(ev.scope) ? ev.scope.filter((s): s is string => typeof s === "string") : [];
      // Attachments persist as {id, mime}; the bubble reloads them by id.
      const images = Array.isArray(ev.attachments)
        ? ev.attachments.flatMap((a: unknown) => {
            const id = str((a as { id?: unknown } | null)?.id);
            return id ? [{ id, mime: str((a as { mime?: unknown }).mime) ?? "" }] : [];
          })
        : [];
      return [
        ...items,
        {
          uid,
          kind: "user",
          text: String(ev.text ?? ""),
          ...(scope.length > 0 ? { scope } : {}),
          ...(images.length > 0 ? { images } : {}),
        },
      ];
    }
    case "text_delta": {
      const text = String(ev.text ?? "");
      const last = items[items.length - 1];
      if (last?.kind === "agent" && last.streaming) {
        return replaceAt(items, items.length - 1, { ...last, text: last.text + text });
      }
      return [...items, { uid, kind: "agent", text, streaming: true }];
    }
    case "text_final": {
      const text = String(ev.text ?? "");
      const last = items[items.length - 1];
      // The settled text replaces the streamed bubble in place (same uid).
      if (last?.kind === "agent" && last.streaming) {
        return replaceAt(items, items.length - 1, { ...last, text, streaming: false });
      }
      return [...items, { uid, kind: "agent", text, streaming: false }];
    }
    case "tool_use":
      return [
        ...items,
        {
          uid,
          kind: "tool",
          id: str(ev.id),
          name: String(ev.name ?? ""),
          detail: String(ev.detail ?? ""),
          input: str(ev.input),
          status: "running",
        },
      ];
    case "tool_result": {
      const id = str(ev.id);
      const i = id === undefined ? -1 : findLast(items, (it) => it.kind === "tool" && it.id === id);
      if (i < 0) return items;
      const it = items[i] as Extract<ChatItem, { kind: "tool" }>;
      const fileDiff = str(ev.fileDiff);
      const resultHead = str(ev.resultHead);
      return replaceAt(items, i, {
        ...it,
        status: ev.isError ? "error" : "done",
        output: str(ev.output),
        ...(fileDiff?.trim() ? { fileDiff } : {}),
        ...(resultHead ? { resultHead } : {}),
      });
    }
    case "question": {
      const questionId = String(ev.questionId ?? "");
      // A replayed or re-broadcast question must not render a second card.
      if (questionId && items.some((it) => it.kind === "question" && it.questionId === questionId)) {
        return items;
      }
      return [
        ...items,
        {
          uid: questionUid(questionId, uid),
          kind: "question",
          questionId,
          questions: Array.isArray(ev.questions) ? (ev.questions as AgentQuestion[]) : [],
          // Later events (answered/dismissed/turn_end) decide how it settles.
          status: "pending",
        },
      ];
    }
    case "question_answered":
    case "question_dismissed": {
      const i = findLast(items, (it) => it.kind === "question" && it.questionId === ev.questionId);
      if (i < 0) return items;
      const it = items[i] as Extract<ChatItem, { kind: "question" }>;
      if (ev.type === "question_dismissed") return replaceAt(items, i, { ...it, status: "dismissed" });
      const answers =
        ev.answers && typeof ev.answers === "object" ? (ev.answers as Record<string, string>) : it.answers;
      return replaceAt(items, i, { ...it, status: "answered", answers });
    }
    case "turn_end": {
      // Close any bubble left streaming (e.g. after an interrupt) and collapse
      // question cards the turn's end left unanswered.
      const closed = items.map((it) =>
        it.kind === "agent" && it.streaming
          ? { ...it, streaming: false }
          : it.kind === "question" && it.status === "pending"
            ? { ...it, status: "dismissed" as const }
            : it,
      );
      if (ev.interrupted) return [...closed, notice(uid, "warn", "Turn interrupted.")];
      return [
        ...closed,
        {
          uid,
          kind: "turn_end",
          costUsd: num(ev.costUsd),
          durationMs: num(ev.durationMs),
          contextTokens: num(ev.contextTokens),
          contextWindow: num(ev.contextWindow),
          inputTokens: num(ev.inputTokens),
          outputTokens: num(ev.outputTokens),
        },
      ];
    }
    case "notice":
      return appendChatItem(
        items,
        notice(uid, TONES.includes(ev.tone as Tone) ? (ev.tone as Tone) : "info", String(ev.text ?? ""), {
          citationGroup: str(ev.citationGroup),
          details: str(ev.details),
        }),
      );
    // The server persists both of these as notices with the same wording.
    case "error":
      return [...items, notice(uid, "error", String(ev.message ?? "agent error"))];
    case "sync_warning":
      return [...items, notice(uid, "warn", `Sync: ${String(ev.message ?? "")}`)];
    // Live-only (approve/discard routes, never persisted to the transcript).
    case "approved": {
      const next = [
        ...items,
        notice(
          uid,
          "ok",
          opts.projectKind === "local" ? "Committed locally." : ev.pushed ? "Changes pushed to Overleaf." : "Nothing to push.",
        ),
      ];
      // Safety-relevant push warnings must reach the user: the OT-fallback
      // notice (comments/tracked changes on a doc may not survive), the
      // forced-overwrite backup location, files to delete manually, …
      if (Array.isArray(ev.warnings) && ev.warnings.length > 0) {
        next.push(notice(`${uid}:warnings`, "warn", ev.warnings.join("\n")));
      }
      // The push also absorbed collaborator edits to files we hadn't
      // touched — the tree changed beyond what was reviewed.
      if (Array.isArray(ev.absorbedRemote) && ev.absorbedRemote.length > 0) {
        next.push(notice(`${uid}:absorbed`, "info", `Also picked up Overleaf changes to: ${ev.absorbedRemote.join(", ")}`));
      }
      return next;
    }
    case "rejected":
      return [...items, notice(uid, "info", "Changes discarded.")];
    default:
      return items;
  }
}

/**
 * Rebuild the chat view from a persisted transcript. Item uids derive from
 * the chat id and the event's position, so restoring the same transcript
 * again (a reconnect backfill) keeps every bubble's identity.
 *
 * A question stays pending until its answered/dismissed event or its turn's
 * end collapses it. `pendingQuestionId` is the turn-state's still-unanswered
 * question (if any): its card restores actionable; a question with NO
 * resolution and NO turn_end that is not the pending one is in an unknown
 * state (e.g. the turn-state snapshot predates it) — it renders as stale
 * ("reload to answer"), never as skipped.
 */
export function replayChatEvents(
  events: ChatTranscriptEvent[],
  chatId: string,
  pendingQuestionId?: string | null,
): ChatItem[] {
  const items = events.reduce<ChatItem[]>((all, ev, i) => applyChatEvent(all, ev, { uid: `${chatId}:${i}` }), []);
  return items.map((it) =>
    it.kind === "question" && it.status === "pending" && it.questionId !== pendingQuestionId
      ? { ...it, status: "stale" as const }
      : it,
  );
}

let liveCount = 0;

/** A fresh identity for an item created live (not replayed from a transcript). */
export function liveChatUid(): string {
  return `live:${++liveCount}`;
}
