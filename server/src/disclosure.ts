/**
 * AI-use disclosure: venues increasingly require authors to disclose how AI
 * tools were used — BlattBot has the real usage record. This module aggregates
 * DETERMINISTIC facts from the chats store (registry + transcripts) and
 * composes a plain factual paragraph from them; the route may afterwards ask
 * the agent to polish the phrasing, falling back to the deterministic text on
 * any failure. Nothing here calls a model.
 */
import { listChats, readTranscript, type ChatEvent } from "./chats.js";
import { isEditTool } from "./livediff.js";

export interface DisclosureFacts {
  /** Completed (non-interrupted) agent turns across all chats. */
  turns: number;
  /** Chats that saw at least one user message. */
  chats: number;
  /** Distinct modes of the user messages, in AGENT_MODES-agnostic sorted order. */
  modes: string[];
  /** Distinct models recorded on turn_end events (absent on old transcripts). */
  models: string[];
  /** Distinct project files touched by agent edit tools. */
  filesTouched: number;
  /** ISO timestamps bounding the recorded usage (null with no usage). */
  firstUse: string | null;
  lastUse: string | null;
}

/** Aggregate the disclosure facts of one project from its stored chats. */
export function collectDisclosureFacts(projectId: string): DisclosureFacts {
  let turns = 0;
  let usedChats = 0;
  const modes = new Set<string>();
  const models = new Set<string>();
  const files = new Set<string>();
  let firstUse: string | null = null;
  let lastUse: string | null = null;

  for (const chat of listChats(projectId)) {
    const events: ChatEvent[] = readTranscript(projectId, chat.id);
    let sawUserMessage = false;
    for (const ev of events) {
      if (ev.type === "user_message") {
        sawUserMessage = true;
        if (typeof ev.mode === "string" && ev.mode) modes.add(ev.mode);
      } else if (ev.type === "turn_end" && !ev.interrupted) {
        turns += 1;
        if (typeof ev.model === "string" && ev.model) models.add(ev.model);
        // Every model that actually served the turn (a fallback shows up here).
        if (Array.isArray(ev.models)) {
          for (const m of ev.models) if (typeof m === "string" && m) models.add(m);
        }
      } else if (
        ev.type === "tool_use" &&
        typeof ev.name === "string" &&
        isEditTool(ev.name) &&
        typeof ev.detail === "string" &&
        ev.detail
      ) {
        files.add(ev.detail);
      }
    }
    // Only chats that were actually used bound the date range.
    if (sawUserMessage) {
      usedChats += 1;
      if (firstUse === null || chat.createdAt < firstUse) firstUse = chat.createdAt;
      if (lastUse === null || chat.updatedAt > lastUse) lastUse = chat.updatedAt;
    }
  }

  return {
    turns,
    chats: usedChats,
    modes: [...modes].sort(),
    models: [...models].sort(),
    filesTouched: files.size,
    firstUse,
    lastUse,
  };
}

const day = (iso: string) => iso.slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A factual base paragraph composed purely from the facts — the fallback (and
 * the polish input) of the disclosure endpoint. Deterministic by design.
 */
export function composeDisclosure(projectName: string, facts: DisclosureFacts): string {
  if (facts.turns === 0) {
    return (
      `No AI assistance is recorded for "${projectName}" in BlattBot — ` +
      `no completed agent turns have been logged for this project.`
    );
  }
  const parts: string[] = [];
  const dates =
    facts.firstUse && facts.lastUse
      ? day(facts.firstUse) === day(facts.lastUse)
        ? ` on ${day(facts.firstUse)}`
        : ` between ${day(facts.firstUse)} and ${day(facts.lastUse)}`
      : "";
  parts.push(
    `During the preparation of "${projectName}", the authors used BlattBot, an AI writing ` +
      `assistant for LaTeX, across ${plural(facts.turns, "agent turn")}${dates}.`,
  );
  if (facts.modes.length > 0) {
    parts.push(`The assistant was used in the following mode(s): ${facts.modes.join(", ")}.`);
  }
  if (facts.models.length > 0) {
    parts.push(`Model(s) used: ${facts.models.join(", ")}.`);
  }
  parts.push(
    facts.filesTouched > 0
      ? `The assistant edited ${plural(facts.filesTouched, "project file")}; every change was ` +
          `presented as a reviewable diff and accepted or rejected by the authors before ` +
          `entering the manuscript.`
      : `The assistant made no direct file edits; its output was reviewed by the authors ` +
          `before any use in the manuscript.`,
  );
  return parts.join(" ");
}
