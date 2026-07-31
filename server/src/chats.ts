/**
 * Persistent per-project chats. Each project can hold multiple conversations;
 * every chat owns its own Agent SDK session id and an append-only transcript.
 *
 * Layout under the data dir:
 *   chats/<projectId>/chats.json     registry: [{id, title, createdAt, updatedAt, sessionId?}]
 *   chats/<projectId>/<chatId>.jsonl transcript, one JSON event per line
 *
 * Events are the UI-relevant subset of a turn (user_message, text_final,
 * tool_use, tool_result incl. fileDiff and the read-only resultHead summary,
 * turn_end, notice) — high-frequency stream deltas are never persisted;
 * text_final carries the full text.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, getProject, updateProject } from "./config.js";

/** Cumulative cost/token totals of one chat — bumped as turn_end events land. */
export interface ChatStats {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Agent SDK session id — conversation continuity is per chat. */
  sessionId?: string;
  /** Running cost/token totals (absent until the first completed turn). */
  stats?: ChatStats;
}

export interface ChatEvent {
  type: string;
  [key: string]: unknown;
}

export const DEFAULT_TITLE = "New chat";
export const LEGACY_TITLE = "Earlier conversation";
export const LEGACY_NOTICE =
  "History from before chat persistence is not available — the agent still remembers this conversation.";
/** Titles derived from the first user message are capped at ~40 chars. */
export const TITLE_MAX = 40;

function chatsDir(projectId: string): string {
  return join(DATA_DIR, "chats", projectId);
}

function registryPath(projectId: string): string {
  return join(chatsDir(projectId), "chats.json");
}

export function transcriptPath(projectId: string, chatId: string): string {
  return join(chatsDir(projectId), `${chatId}.jsonl`);
}

function loadRegistry(projectId: string): ChatMeta[] {
  const path = registryPath(projectId);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? (raw as ChatMeta[]) : [];
  } catch {
    return [];
  }
}

function saveRegistry(projectId: string, chats: ChatMeta[]): void {
  mkdirSync(chatsDir(projectId), { recursive: true });
  writeFileSync(registryPath(projectId), JSON.stringify(chats, null, 2), { mode: 0o600 });
}

/**
 * One-time migration: a project that already has a legacy per-project session
 * but has never had chats gets an "Earlier conversation" chat carrying that
 * session id, so resuming still works. The old UI transcript is gone — a
 * synthetic notice in the new transcript says so. Guarded on the registry
 * FILE existing (not on it being empty) so deleting every chat later does
 * not resurrect the legacy conversation.
 */
function migrateLegacySession(projectId: string): void {
  if (existsSync(registryPath(projectId))) return;
  const project = getProject(projectId);
  if (!project?.sessionId) return;
  const now = new Date().toISOString();
  const chat: ChatMeta = {
    id: newChatId(),
    title: LEGACY_TITLE,
    createdAt: now,
    updatedAt: now,
    sessionId: project.sessionId,
  };
  saveRegistry(projectId, [chat]);
  appendFileSync(
    transcriptPath(projectId, chat.id),
    JSON.stringify({ type: "notice", tone: "info", text: LEGACY_NOTICE } satisfies ChatEvent) + "\n",
  );
  updateProject(projectId, { activeChatId: chat.id });
}

function newChatId(): string {
  return `chat-${randomBytes(4).toString("hex")}`;
}

/** All chats of a project, newest-updated first. Runs the legacy migration on first access. */
export function listChats(projectId: string): ChatMeta[] {
  migrateLegacySession(projectId);
  return loadRegistry(projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createChat(projectId: string): ChatMeta {
  migrateLegacySession(projectId);
  const chats = loadRegistry(projectId);
  const now = new Date().toISOString();
  const chat: ChatMeta = { id: newChatId(), title: DEFAULT_TITLE, createdAt: now, updatedAt: now };
  chats.push(chat);
  saveRegistry(projectId, chats);
  return chat;
}

export function getChat(projectId: string, chatId: string): ChatMeta | undefined {
  return listChats(projectId).find((c) => c.id === chatId);
}

/** Patch a chat's mutable fields (title, sessionId); bumps updatedAt. */
export function updateChat(
  projectId: string,
  chatId: string,
  patch: Partial<Pick<ChatMeta, "title" | "sessionId">>,
): ChatMeta | undefined {
  const chats = loadRegistry(projectId);
  const idx = chats.findIndex((c) => c.id === chatId);
  if (idx === -1) return undefined;
  chats[idx] = { ...chats[idx], ...patch, id: chatId, updatedAt: new Date().toISOString() };
  saveRegistry(projectId, chats);
  return chats[idx];
}

/** Compact one-line title from the first user message. */
export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= TITLE_MAX) return clean;
  return clean.slice(0, TITLE_MAX - 1).trimEnd() + "…";
}

/**
 * Fold a turn_end event into the chat's running totals and the project's
 * cumulative stats. Interrupted turns are skipped (aborted, cost unknown);
 * cost/token fields add only when the backend reported them.
 */
function recordTurnEnd(projectId: string, chat: ChatMeta, event: ChatEvent): void {
  if (event.interrupted) return;
  const stats: ChatStats = chat.stats ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
  stats.turns += 1;
  if (typeof event.costUsd === "number") stats.costUsd += event.costUsd;
  if (typeof event.inputTokens === "number") stats.inputTokens += event.inputTokens;
  if (typeof event.outputTokens === "number") stats.outputTokens += event.outputTokens;
  chat.stats = stats;
  const project = getProject(projectId);
  if (project) {
    const prev = project.stats ?? { totalCostUsd: 0, totalTurns: 0 };
    updateProject(projectId, {
      stats: {
        totalCostUsd: prev.totalCostUsd + (typeof event.costUsd === "number" ? event.costUsd : 0),
        totalTurns: prev.totalTurns + 1,
      },
    });
  }
}

/**
 * Append one event to a chat's transcript and bump its updatedAt. The first
 * user message a fresh chat receives becomes its title; turn_end events also
 * feed the chat's and the project's cumulative cost totals.
 */
export function appendEvent(projectId: string, chatId: string, event: ChatEvent): void {
  const chats = loadRegistry(projectId);
  const idx = chats.findIndex((c) => c.id === chatId);
  if (idx === -1) throw new Error(`unknown chat: ${chatId}`);
  mkdirSync(chatsDir(projectId), { recursive: true });
  appendFileSync(transcriptPath(projectId, chatId), JSON.stringify(event) + "\n");
  const chat = chats[idx];
  chat.updatedAt = new Date().toISOString();
  if (
    event.type === "user_message" &&
    chat.title === DEFAULT_TITLE &&
    typeof event.text === "string" &&
    event.text.trim()
  ) {
    chat.title = deriveTitle(event.text);
  }
  if (event.type === "turn_end") recordTurnEnd(projectId, chat, event);
  saveRegistry(projectId, chats);
}

/** The chat's stored events, oldest first. Malformed lines are skipped. */
export function readTranscript(projectId: string, chatId: string): ChatEvent[] {
  const path = transcriptPath(projectId, chatId);
  if (!existsSync(path)) return [];
  const events: ChatEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.type === "string") events.push(parsed as ChatEvent);
    } catch {
      /* partial/corrupt line — skip */
    }
  }
  return events;
}

export function deleteChat(projectId: string, chatId: string): boolean {
  const chats = loadRegistry(projectId);
  const next = chats.filter((c) => c.id !== chatId);
  if (next.length === chats.length) return false;
  saveRegistry(projectId, next);
  rmSync(transcriptPath(projectId, chatId), { force: true });
  const project = getProject(projectId);
  if (project?.activeChatId === chatId) {
    updateProject(projectId, { activeChatId: undefined });
  }
  return true;
}

/**
 * Resolve the project's active chat: a valid activeChatId wins; otherwise the
 * most recently updated chat is (re)activated; with no chats at all a fresh
 * one is created and activated.
 */
export function ensureActiveChat(projectId: string): ChatMeta {
  const chats = listChats(projectId);
  const project = getProject(projectId);
  const current = project?.activeChatId
    ? chats.find((c) => c.id === project.activeChatId)
    : undefined;
  if (current) return current;
  const next = chats[0] ?? createChat(projectId);
  updateProject(projectId, { activeChatId: next.id });
  return next;
}

/** Mark a chat active. Returns undefined for an unknown chat. */
export function setActiveChat(projectId: string, chatId: string): ChatMeta | undefined {
  const chat = getChat(projectId, chatId);
  if (!chat) return undefined;
  updateProject(projectId, { activeChatId: chatId });
  return chat;
}

/** Chat meta as sent to the UI — the session id stays server-side. */
export function publicChat(chat: ChatMeta): Omit<ChatMeta, "sessionId"> {
  const { sessionId, ...rest } = chat;
  return rest;
}
