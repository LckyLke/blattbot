/**
 * Line-based three-way merge for the server, on top of `git merge-file`.
 *
 * `base` is the last version both sides shared, `ours` the local version and
 * `theirs` the other side (an Overleaf snapshot, or the pre-turn text when a
 * turn is undone). Regions that only one side changed take that side; regions
 * both sides changed differently become conflict blocks and are counted.
 *
 * The web editor keeps its own pure merge (web/src/merge3.ts) because it runs
 * in the browser; this one is for sync, approval and undo on the server.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MergeTextResult {
  /** The merged bytes; holds conflict blocks when `conflicts` > 0. */
  content: Buffer;
  /** Number of conflict blocks in `content` (0 = clean merge). */
  conflicts: number;
}

export interface MergeLabels {
  ours?: string;
  base?: string;
  theirs?: string;
}

/** Binary content (a NUL byte in the first 8 KB, as git judges it) is not merged. */
export function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/**
 * Merge three versions of one file. Returns null when the inputs cannot be
 * merged as text (binary content, or git failed).
 */
export async function mergeText(
  base: Buffer,
  ours: Buffer,
  theirs: Buffer,
  labels: MergeLabels = {},
): Promise<MergeTextResult | null> {
  if (ours.equals(theirs)) return { content: ours, conflicts: 0 };
  if (base.equals(ours)) return { content: theirs, conflicts: 0 };
  if (base.equals(theirs)) return { content: ours, conflicts: 0 };
  if (looksBinary(base) || looksBinary(ours) || looksBinary(theirs)) return null;
  const dir = mkdtempSync(join(tmpdir(), "blattbot-merge-"));
  try {
    const paths = { ours: join(dir, "ours"), base: join(dir, "base"), theirs: join(dir, "theirs") };
    writeFileSync(paths.ours, ours);
    writeFileSync(paths.base, base);
    writeFileSync(paths.theirs, theirs);
    const args = [
      "merge-file",
      "-p",
      "-L", labels.ours ?? "yours",
      "-L", labels.base ?? "base",
      "-L", labels.theirs ?? "theirs",
      paths.ours,
      paths.base,
      paths.theirs,
    ];
    return await new Promise<MergeTextResult | null>((resolve) => {
      execFile("git", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        // Exit status = number of conflicts (capped at 127); negative/large = error.
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : -1) : 0;
        if (code < 0 || code > 127) return resolve(null);
        resolve({ content: Buffer.from(stdout), conflicts: code });
      });
    });
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read a file for a merge; an absent file reads as empty. */
export function readOrEmpty(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
}
