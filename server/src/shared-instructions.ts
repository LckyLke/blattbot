/**
 * Shared project instructions: a `blattbot.md` file at the project root holds
 * agent instructions every co-author's BlattBot uses (it syncs through
 * Overleaf like any other file).
 *
 * Co-authors can change the file, so it is pinned by SHA-256: the agent only
 * uses a version the user confirmed in Project settings. When the file
 * changes, the previously confirmed text (or nothing) stays in use until the
 * user confirms the new one, and each turn says so in the chat. A removed
 * file means no shared instructions. The local per-project instructions
 * (settings.styleAppend) still apply after these.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProject, projectDir, updateProject, type Project } from "./config.js";

export const SHARED_INSTRUCTIONS_FILE = "blattbot.md";
/** Same cap as the local project instructions (MAX_STYLE_APPEND in agent.ts). */
export const MAX_SHARED_INSTRUCTIONS = 4000;
/** Larger files are not read at all. */
const MAX_FILE_BYTES = 256 * 1024;

export type SharedInstructionsStatus = "none" | "confirmed" | "unconfirmed";

export interface SharedInstructionsState {
  file: string;
  exists: boolean;
  /** The file's text (empty when absent; cut at 64 KiB for display). */
  content: string;
  sha256: string | null;
  /** The file is longer than the part the agent gets. */
  truncated: boolean;
  status: SharedInstructionsStatus;
  confirmedSha256: string | null;
  confirmedAt: string | null;
  /** What the agent uses this turn: the confirmed text, or null. */
  active: string | null;
  /** The file differs from the confirmed version (or was never confirmed). */
  needsReview: boolean;
  /** A confirmed version is in use while the file has changed since. */
  usingPrevious: boolean;
  /** The file could not be read (too large, binary). */
  error?: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readFile(project: Pick<Project, "id">): { content: string; error?: string } | null {
  const abs = join(projectDir(project.id), SHARED_INSTRUCTIONS_FILE);
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  if (size > MAX_FILE_BYTES) return { content: "", error: `${SHARED_INSTRUCTIONS_FILE} is larger than ${MAX_FILE_BYTES / 1024} KiB and is ignored` };
  const buf = readFileSync(abs);
  if (buf.includes(0)) return { content: "", error: `${SHARED_INSTRUCTIONS_FILE} is not a text file and is ignored` };
  return { content: buf.toString("utf8") };
}

/** The file, its hash, and which version the agent uses. */
export function sharedInstructionsState(project: Pick<Project, "id" | "sharedInstructions">): SharedInstructionsState {
  const pinned = project.sharedInstructions;
  const file = readFile(project);
  const base = {
    file: SHARED_INSTRUCTIONS_FILE,
    confirmedSha256: pinned?.sha256 ?? null,
    confirmedAt: pinned?.confirmedAt ?? null,
  };
  if (!file || file.error) {
    return {
      ...base,
      exists: Boolean(file),
      content: "",
      sha256: null,
      truncated: false,
      status: "none",
      active: null,
      needsReview: false,
      usingPrevious: false,
      ...(file?.error ? { error: file.error } : {}),
    };
  }
  const hash = sha256(file.content);
  const confirmed = pinned?.sha256 === hash;
  const usable = (text: string) => text.trim().slice(0, MAX_SHARED_INSTRUCTIONS).trim() || null;
  const active = confirmed ? usable(file.content) : pinned ? usable(pinned.content) : null;
  // An empty file has nothing to confirm.
  const empty = !file.content.trim();
  return {
    ...base,
    exists: true,
    content: file.content.slice(0, 64 * 1024),
    sha256: hash,
    truncated: file.content.trim().length > MAX_SHARED_INSTRUCTIONS,
    status: confirmed || empty ? (empty ? "none" : "confirmed") : "unconfirmed",
    active: empty ? null : active,
    needsReview: !confirmed && !empty,
    usingPrevious: !confirmed && !empty && Boolean(pinned) && active !== null,
  };
}

/**
 * Confirm the file's current content for the agent. `expectedSha256` is the
 * hash the user reviewed: a file that changed in between is refused.
 */
export function confirmSharedInstructions(projectId: string, expectedSha256: string): SharedInstructionsState {
  const project = getProject(projectId);
  if (!project) throw new Error("unknown project");
  const file = readFile(project);
  if (!file) throw new SharedInstructionsError(`${SHARED_INSTRUCTIONS_FILE} is not in the project any more`);
  if (file.error) throw new SharedInstructionsError(file.error);
  const hash = sha256(file.content);
  if (hash !== expectedSha256) {
    throw new SharedInstructionsError(`${SHARED_INSTRUCTIONS_FILE} changed while you were reviewing it — review the new version`);
  }
  const updated = updateProject(projectId, {
    sharedInstructions: { sha256: hash, content: file.content, confirmedAt: new Date().toISOString() },
  })!;
  return sharedInstructionsState(updated);
}

/** The confirm/create request no longer matches the file (HTTP 409). */
export class SharedInstructionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedInstructionsError";
  }
}

/** The chat notice for a turn that runs without the current blattbot.md. */
export function sharedInstructionsNotice(state: SharedInstructionsState): string | null {
  if (!state.needsReview) return null;
  const now = state.usingPrevious
    ? "This turn uses the version you confirmed earlier."
    : "This turn runs without shared instructions.";
  const what = state.confirmedSha256 ? "blattbot.md changed" : "blattbot.md is new";
  return `${what} — review it in Project settings. ${now}`;
}

/** The blattbot.md text a "create from my project instructions" writes. */
export function sharedInstructionsTemplate(styleAppend: string): string {
  return (
    "<!-- Shared BlattBot instructions for this project. Every co-author's BlattBot\n" +
    "     uses them after confirming them in Project settings. -->\n\n" +
    `${styleAppend.trim()}\n`
  );
}
