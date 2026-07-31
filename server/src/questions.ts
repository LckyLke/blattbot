/**
 * Mid-turn questions: the agent can ask the user 1–4 multiple-choice questions
 * (the Claude SDK's AskUserQuestion tool / the openai backend's ask_user tool)
 * and the turn blocks until the user answers, dismisses, or stops the turn.
 *
 * This module owns the per-project pending-question registry plus the shared
 * ask flow both backends call: validate → register → emit a `question` event
 * (broadcast + persisted by the chat route's sink) → await the user's
 * resolution (delivered via the question routes in index.ts) → emit
 * `question_answered` / `question_dismissed`. At most ONE question is pending
 * per project turn — the backends serialize tool calls, so a second concurrent
 * ask is a fail-fast error the caller turns into a deny.
 *
 * Dependency leaf like backends/types.ts: imported by both backends, agent.ts,
 * and index.ts — it must not import any of them.
 */
import { randomBytes } from "node:crypto";
import type { EventSink } from "./backends/types.js";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface AgentQuestion {
  /** The full question text — also the key of the answers record. */
  question: string;
  /** Short chip label (≤ MAX_HEADER chars). */
  header: string;
  /** 2–4 mutually exclusive choices (the UI always adds a free-text "Other"). */
  options: QuestionOption[];
  /** Multi-select answers are comma-joined into one string by the UI. */
  multiSelect: boolean;
}

export interface PendingQuestion {
  questionId: string;
  projectId: string;
  questions: AgentQuestion[];
  createdAt: string;
}

export type QuestionResolution =
  | { kind: "answered"; answers: Record<string, string> }
  | { kind: "dismissed" }
  | { kind: "aborted" };

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER = 12;
/** Per-answer cap — free-text "Other" answers are clamped to this. */
export const MAX_ANSWER_CHARS = 4000;

/**
 * Validate/clamp a raw `questions` tool input into the shape the UI renders.
 * Throws on anything unrenderable (no text, fewer than two usable options).
 */
export function validateQuestions(raw: unknown): AgentQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("questions must be a non-empty array");
  }
  return raw.slice(0, MAX_QUESTIONS).map((q: any, i: number) => {
    const question = typeof q?.question === "string" ? q.question.trim() : "";
    if (!question) throw new Error(`question ${i + 1} has no question text`);
    const header =
      (typeof q?.header === "string" ? q.header.trim() : "").slice(0, MAX_HEADER) || "Question";
    const options: QuestionOption[] = (Array.isArray(q?.options) ? q.options : [])
      .filter((o: any) => typeof o?.label === "string" && o.label.trim())
      .slice(0, MAX_OPTIONS)
      .map((o: any) => ({
        label: o.label.trim(),
        description: typeof o?.description === "string" ? o.description : "",
      }));
    if (options.length < MIN_OPTIONS) {
      throw new Error(`question ${i + 1} needs at least ${MIN_OPTIONS} options`);
    }
    return { question, header, options, multiSelect: Boolean(q?.multiSelect) };
  });
}

/**
 * Validate a POST body's answers record against the pending question set:
 * every key must be one of the question texts (anything else would be injected
 * verbatim into the model conversation), every single-select question must be
 * answered (a multi-select may legitimately end up empty), and values are
 * clamped to MAX_ANSWER_CHARS.
 */
export function validateAnswers(
  raw: unknown,
  questions: AgentQuestion[],
): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("answers must be an object mapping question text to the answer");
  }
  const texts = new Set(questions.map((q) => q.question));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!texts.has(key)) {
      throw new Error(`unknown question: ${key.slice(0, 80)}`);
    }
    if (typeof value !== "string") throw new Error("every answer must be a string");
    out[key] = value.slice(0, MAX_ANSWER_CHARS);
  }
  for (const q of questions) {
    if (!q.multiSelect && !out[q.question]?.trim()) {
      throw new Error(`missing answer for: ${q.question.slice(0, 80)}`);
    }
  }
  if (Object.keys(out).length === 0) throw new Error("answers must not be empty");
  return out;
}

// ---- Registry ---------------------------------------------------------------

interface RegistryEntry {
  pending: PendingQuestion;
  resolve: (result: QuestionResolution) => void;
}

/** One pending question per project (the backends serialize tool calls). */
const active = new Map<string, RegistryEntry>();
/**
 * Recently settled ids so a late double-answer gets 410, not 404 — scoped by
 * project: an id settled under another project must stay "unknown" here.
 */
const recentlyResolved: { projectId: string; questionId: string }[] = [];
const RESOLVED_MEMORY = 100;

function wasResolved(projectId: string, questionId: string): boolean {
  return recentlyResolved.some(
    (r) => r.projectId === projectId && r.questionId === questionId,
  );
}

/**
 * Register a pending question. Throws when the project already has one —
 * callers deny the second ask instead of queueing it.
 */
export function registerQuestion(
  projectId: string,
  questions: AgentQuestion[],
): { pending: PendingQuestion; resolution: Promise<QuestionResolution> } {
  if (active.has(projectId)) {
    throw new Error("a question is already pending for this project");
  }
  const pending: PendingQuestion = {
    questionId: `q-${randomBytes(4).toString("hex")}`,
    projectId,
    questions,
    createdAt: new Date().toISOString(),
  };
  let resolve!: (result: QuestionResolution) => void;
  const resolution = new Promise<QuestionResolution>((r) => (resolve = r));
  active.set(projectId, { pending, resolve });
  return { pending, resolution };
}

export type SettleOutcome = "ok" | "unknown" | "resolved";

function settle(projectId: string, questionId: string, result: QuestionResolution): SettleOutcome {
  const entry = active.get(projectId);
  if (!entry || entry.pending.questionId !== questionId) {
    return wasResolved(projectId, questionId) ? "resolved" : "unknown";
  }
  active.delete(projectId);
  recentlyResolved.push({ projectId, questionId });
  if (recentlyResolved.length > RESOLVED_MEMORY) recentlyResolved.shift();
  entry.resolve(result);
  return "ok";
}

export function answerQuestion(
  projectId: string,
  questionId: string,
  answers: Record<string, string>,
): SettleOutcome {
  return settle(projectId, questionId, { kind: "answered", answers });
}

export function dismissQuestion(projectId: string, questionId: string): SettleOutcome {
  return settle(projectId, questionId, { kind: "dismissed" });
}

/**
 * Resolve the project's pending question (if any) as aborted — the turn was
 * interrupted or the backend died. Never throws; safe to call unconditionally.
 */
export function abortQuestion(projectId: string, questionId?: string): void {
  const entry = active.get(projectId);
  if (!entry) return;
  if (questionId !== undefined && entry.pending.questionId !== questionId) return;
  settle(projectId, entry.pending.questionId, { kind: "aborted" });
}

/** The project's pending question, for the turn-state payload the UI restores from. */
export function pendingQuestion(projectId: string): PendingQuestion | undefined {
  return active.get(projectId)?.pending;
}

/**
 * Where this question id stands FOR THIS PROJECT: currently pending, recently
 * settled ("resolved" → 410), or never seen here ("unknown" → 404). Lets the
 * answer route look up the pending questions (to validate the answers against)
 * before it commits to settling.
 */
export function questionStatus(
  projectId: string,
  questionId: string,
): "pending" | "resolved" | "unknown" {
  const entry = active.get(projectId);
  if (entry && entry.pending.questionId === questionId) return "pending";
  return wasResolved(projectId, questionId) ? "resolved" : "unknown";
}

// ---- The shared ask flow ----------------------------------------------------

/**
 * Run one ask: register the pending question, emit `question` through the turn
 * sink (which broadcasts it over the websocket and persists it to the chat
 * transcript), await the user's resolution, and emit the matching
 * `question_answered` / `question_dismissed` event. Any of the given abort
 * signals resolves the question as aborted (no *_dismissed event — the
 * interrupted turn_end tells the story). Throws only when a question is
 * already pending for the project.
 */
export async function askUserQuestions(
  projectId: string,
  emit: EventSink,
  questions: AgentQuestion[],
  signals: (AbortSignal | undefined)[] = [],
): Promise<QuestionResolution> {
  const { pending, resolution } = registerQuestion(projectId, questions);
  const onAbort = () => abortQuestion(projectId, pending.questionId);
  const hooked: AbortSignal[] = [];
  let preAborted = false;
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      onAbort();
      preAborted = true;
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    hooked.push(signal);
  }
  // A question aborted before it was ever shown never reaches the UI.
  if (!preAborted) {
    emit({ type: "question", projectId, questionId: pending.questionId, questions });
  }
  const result = await resolution;
  for (const signal of hooked) signal.removeEventListener("abort", onAbort);
  if (result.kind === "answered") {
    emit({ type: "question_answered", questionId: pending.questionId, answers: result.answers });
  } else if (result.kind === "dismissed") {
    emit({ type: "question_dismissed", questionId: pending.questionId });
  }
  return result;
}
