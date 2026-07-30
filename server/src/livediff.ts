/**
 * Live-diff plumbing for an agent turn: wraps the event sink handed to
 * runTurn so that
 *   1. after every editing-tool result the full working diff is re-broadcast
 *      (debounced, tagged { live: true }) so the Proof tab updates mid-turn, and
 *   2. editing-tool results are enriched with the touched file's own diff
 *      ({ ...tool_result, fileDiff }) for the chat's per-edit expander.
 *
 * Pure logic lives here (edit-tool detection, debouncing, untracked-file diff
 * synthesis, truncation) with the git calls injectable for unit tests.
 */
import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
// Function-level circular import (git.fileDiff uses synthesizeUntrackedDiff):
// safe in ESM because both modules only reference each other at call time.
import * as git from "./git.js";

export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

/** File-editing tools whose results should refresh the diff (plain SDK names). */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools that change files without a file_path detail — refresh only, no per-edit diff. */
const REFRESH_ONLY_TOOLS = new Set(["mcp__blattbot__add_citation"]);

export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

export const MAX_FILE_DIFF_BYTES = 40_000;
export const TRUNCATION_MARKER = "… [diff truncated]";

/** Cap a diff at maxBytes, cutting on a line boundary and appending a marker. */
export function truncateDiff(diff: string, maxBytes = MAX_FILE_DIFF_BYTES): string {
  if (Buffer.byteLength(diff, "utf8") <= maxBytes) return diff;
  const cut = Buffer.from(diff, "utf8").subarray(0, maxBytes).toString("utf8");
  const nl = cut.lastIndexOf("\n");
  return (nl > 0 ? cut.slice(0, nl) : cut) + "\n" + TRUNCATION_MARKER;
}

/**
 * Build a unified all-added diff for a file `git diff HEAD` cannot see yet
 * (brand-new, untracked). Mirrors git's own new-file output closely enough
 * for the web parser and for `git apply --reverse`.
 */
export function synthesizeUntrackedDiff(relPath: string, content: Buffer | string): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n`;
  if (buf.includes(0)) {
    return header + `Binary files /dev/null and b/${relPath} differ\n`;
  }
  const text = buf.toString("utf8");
  if (text.length === 0) return header;
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  let body = lines.map((l) => `+${l}`).join("\n") + "\n";
  if (!endsWithNewline) body += "\\ No newline at end of file\n";
  return header + `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n` + body;
}

export interface TurnEventSinkOptions {
  /** Trailing debounce for the live working-diff broadcast. */
  debounceMs?: number;
  maxFileDiffBytes?: number;
  /** Injectable for tests — defaults to the real git helpers / fs check. */
  workingDiff?: (dir: string) => Promise<string>;
  fileDiff?: (dir: string, relPath: string) => Promise<string>;
  fileExists?: (dir: string, relPath: string) => boolean;
}

export interface TurnEventSink {
  /** The event sink to pass to runTurn. */
  sink: (event: AgentEventLike) => void;
  /** Cancel any pending live-diff timer and wait for in-flight enrichment. */
  close(): Promise<void>;
}

function defaultFileExists(dir: string, relPath: string): boolean {
  try {
    return statSync(join(dir, relPath)).isFile();
  } catch {
    return false;
  }
}

/** True when `relPath` is a clean relative path that stays inside `dir`. */
function isInsideProject(dir: string, relPath: string): boolean {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return false;
  const abs = resolve(dir, relPath);
  return abs !== dir && abs.startsWith(dir + sep);
}

export function makeTurnEventSink(
  dir: string,
  emit: (event: AgentEventLike) => void,
  options: TurnEventSinkOptions = {},
): TurnEventSink {
  const debounceMs = options.debounceMs ?? 400;
  const maxBytes = options.maxFileDiffBytes ?? MAX_FILE_DIFF_BYTES;
  const workingDiff = options.workingDiff ?? git.workingDiff;
  const fileDiff = options.fileDiff ?? git.fileDiff;
  const fileExists = options.fileExists ?? defaultFileExists;

  /** tool_use id → { name, detail } so results can be matched back. */
  const toolUses = new Map<string, { name: string; detail: string }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** Chain enrichments so edit results keep their relative order. */
  let pending: Promise<void> = Promise.resolve();

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleLiveDiff() {
    if (closed) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      void workingDiff(dir)
        .then((diff) => {
          if (!closed) emit({ type: "diff", diff, live: true });
        })
        .catch(() => {
          /* mid-turn diff is best-effort — the final broadcast is authoritative */
        });
    }, debounceMs);
  }

  function sink(event: AgentEventLike): void {
    if (event.type === "tool_use" && typeof event.id === "string") {
      toolUses.set(event.id, {
        name: typeof event.name === "string" ? event.name : "",
        detail: typeof event.detail === "string" ? event.detail : "",
      });
      emit(event);
      return;
    }

    if (event.type === "turn_end") {
      // Nothing may fire into the UI after turn cleanup — the route's final
      // (non-live) diff broadcast takes over from here.
      clearTimer();
      emit(event);
      return;
    }

    if (event.type === "tool_result" && typeof event.id === "string") {
      const use = toolUses.get(event.id);
      if (use && (isEditTool(use.name) || REFRESH_ONLY_TOOLS.has(use.name))) {
        scheduleLiveDiff();
        const rel = use.detail;
        if (isEditTool(use.name) && !event.isError && isInsideProject(dir, rel) && fileExists(dir, rel)) {
          // Enrich asynchronously; the UI matches results by id, so slight
          // reordering against later stream events is harmless.
          pending = pending.then(async () => {
            let enriched = event;
            try {
              const d = await fileDiff(dir, rel);
              if (d.trim()) enriched = { ...event, fileDiff: truncateDiff(d, maxBytes) };
            } catch {
              /* fall back to the plain result */
            }
            emit(enriched);
          });
          return;
        }
      }
      emit(event);
      return;
    }

    emit(event);
  }

  return {
    sink,
    async close() {
      closed = true;
      clearTimer();
      await pending;
    },
  };
}
