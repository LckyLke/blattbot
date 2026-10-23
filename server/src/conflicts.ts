/**
 * Detail for files that both Overleaf and the local tree changed: what each
 * side did to the overlapping regions (Overleaf | base | yours), for the
 * Proof view's conflict banner, plus the conflict-marker check approve uses.
 */
import { looksBinary, mergeText } from "./merge.js";

/** Marker labels for every server merge shown to the user. */
export const CONFLICT_LABELS = { ours: "yours", base: "base", theirs: "Overleaf" } as const;

export interface ConflictHunk {
  /** 1-based line in your version where the overlap starts. */
  line: number;
  mine: string;
  base: string;
  remote: string;
}

export interface RemoteConflict {
  path: string;
  /**
   * "deleted-remote": deleted on Overleaf but edited locally; "deleted-local":
   * deleted locally but changed on Overleaf; "unmerged": a Git-bridge sync
   * left conflict markers in the file.
   */
  kind: "modified" | "deleted-remote" | "deleted-local" | "unmerged";
  /** Not text on every side — no line merge or hunks. */
  binary?: boolean;
  /** The overlapping regions (text files). */
  hunks?: ConflictHunk[];
  /** Overlapping regions beyond the listed hunks. */
  more?: number;
}

const MAX_HUNKS = 20;
const MAX_SIDE = 4000;

const clip = (lines: string[]) => {
  const text = lines.join("\n");
  return text.length > MAX_SIDE ? `${text.slice(0, MAX_SIDE)}…` : text;
};

/** The conflict blocks of a diff3-style merge (`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`). */
export function parseConflictHunks(text: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let line = 1;
  let cur: { line: number; mine: string[]; base: string[]; remote: string[] } | null = null;
  let section: "mine" | "base" | "remote" = "mine";
  for (const l of text.split("\n")) {
    if (!cur) {
      if (/^<{7}(?: |$)/.test(l)) {
        cur = { line, mine: [], base: [], remote: [] };
        section = "mine";
      } else {
        line++;
      }
      continue;
    }
    if (section === "mine" && /^\|{7}(?: |$)/.test(l)) {
      section = "base";
      continue;
    }
    if (section !== "remote" && /^={7}$/.test(l)) {
      section = "remote";
      continue;
    }
    if (section === "remote" && /^>{7}(?: |$)/.test(l)) {
      hunks.push({ line: cur.line, mine: clip(cur.mine), base: clip(cur.base), remote: clip(cur.remote) });
      cur = null;
      continue;
    }
    cur[section].push(l);
    if (section === "mine") line++;
  }
  return hunks;
}

/**
 * Describe one conflicted file: base = HEAD, mine = the local version,
 * remote = Overleaf's (null = the file is absent on that side).
 */
export async function describeConflict(
  path: string,
  base: Buffer | null,
  mine: Buffer | null,
  remote: Buffer | null,
): Promise<RemoteConflict> {
  if (!remote) return { path, kind: "deleted-remote" };
  if (!mine) return { path, kind: "deleted-local" };
  if (looksBinary(remote) || looksBinary(mine) || (base && looksBinary(base))) {
    return { path, kind: "modified", binary: true };
  }
  const merged = await mergeText(base ?? Buffer.alloc(0), mine, remote, CONFLICT_LABELS, { diff3: true });
  if (!merged) return { path, kind: "modified", binary: true };
  const hunks = parseConflictHunks(merged.content.toString("utf8"));
  return {
    path,
    kind: "modified",
    hunks: hunks.slice(0, MAX_HUNKS),
    ...(hunks.length > MAX_HUNKS ? { more: hunks.length - MAX_HUNKS } : {}),
  };
}

/** Text that still holds `<<<<<<<` … `>>>>>>>` conflict markers. */
export function hasConflictMarkers(content: Buffer | string | null | undefined): boolean {
  if (!content) return false;
  const text = typeof content === "string" ? content : content.toString("utf8");
  return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text);
}
