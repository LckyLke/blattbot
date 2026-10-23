/**
 * The Proof's default commit message, derived from the open chat: the
 * prompt of the latest agent turn that edited files since the last full
 * approval ("Agent: tighten the related-work paragraph"), "Manual edits"
 * when the last approval came after every agent edit, and the old default
 * when the chat says nothing either way. A pending revert wins.
 */
import type { ChatItem } from "./chat-events.js";

export const FALLBACK_MESSAGE = "BlattBot edit";
export const MANUAL_MESSAGE = "Manual edits";
/** Subject lines stay around git's customary width. */
const MAX_SUBJECT = 72;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function agentSubject(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, " ") ?? "";
  if (!line) return "Agent edit";
  const room = MAX_SUBJECT - "Agent: ".length;
  return `Agent: ${line.length > room ? `${line.slice(0, room - 1).trimEnd()}…` : line}`;
}

export function defaultApproveMessage(items: ChatItem[], pendingRevert?: string | null): string {
  if (pendingRevert) return pendingRevert;
  let edited = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.status !== "error" && (it.fileDiff || EDIT_TOOLS.has(it.name))) edited = true;
    else if (it.kind === "user") {
      if (edited) return agentSubject(it.text);
    } else if (it.kind === "notice" && it.source === "approve") {
      // Everything after a full approval came from somewhere else.
      return MANUAL_MESSAGE;
    }
  }
  return FALLBACK_MESSAGE;
}

/** The message for approving one file or hunk on its own. */
export function partMessage(base: string, path: string): string {
  return base === FALLBACK_MESSAGE ? `${base}: ${path}` : `${base} (${path})`;
}
