/** Parse unified `git diff` output into a renderable structure. */

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
  /** The exact `@@ -a,b +c,d @@ …` line as emitted by git. */
  rawHeader: string;
  /** The raw body lines (with their +/-/space/\ prefixes), for patch reconstruction. */
  rawLines: string[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!diff.trim()) return files;
  const lines = diff.split("\n");
  // The final newline produces an empty split artifact — not a context line.
  if (lines[lines.length - 1] === "") lines.pop();
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // diff --git a/path b/path
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = {
        path: m ? m[2] : line.slice(11),
        oldPath: m && m[1] !== m[2] ? m[1] : undefined,
        status: "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from")) {
      file.status = "renamed";
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      hunk = { header: m?.[3]?.trim() ?? "", lines: [], rawHeader: line, rawLines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      hunk.rawLines.push(line);
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      hunk.rawLines.push(line);
      file.deletions++;
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      hunk.rawLines.push(line);
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line });
      hunk.rawLines.push(line);
    }
  }
  return files;
}

/**
 * Reconstruct a full, standalone unified patch for a single hunk — exactly the
 * text `git apply --reverse` needs to undo just that change. New/deleted files
 * use /dev/null on the appropriate side; renamed files revert content against
 * the current (new) path only.
 */
export function buildHunkPatch(file: DiffFile, hunk: DiffHunk): string {
  const isNew = file.status === "added";
  const isDeleted = file.status === "deleted";
  const out: string[] = [`diff --git a/${file.path} b/${file.path}`];
  if (isNew) out.push("new file mode 100644");
  if (isDeleted) out.push("deleted file mode 100644");
  out.push(isNew ? "--- /dev/null" : `--- a/${file.path}`);
  out.push(isDeleted ? "+++ /dev/null" : `+++ b/${file.path}`);
  out.push(hunk.rawHeader, ...hunk.rawLines);
  return out.join("\n") + "\n";
}
