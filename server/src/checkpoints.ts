/**
 * Working-tree checkpoints: full snapshots of a project's worktree (tracked
 * and untracked files; ignored files stay out) stored as git commits under
 * refs/blattbot/. Taking one never touches the real index or the worktree —
 * it stages into a temporary index (GIT_INDEX_FILE).
 *
 *   refs/blattbot/turns/<chatId>/<n>-before|after   one agent turn
 *   refs/blattbot/discard/<id>                      the tree right after a discard;
 *                                                   its parent is the tree before it
 *
 * Undoing a turn or a discard goes through reverseChanges: a three-way merge
 * per file against the CURRENT worktree, so edits made afterwards survive.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { assertNoSymlinkPath } from "./backends/paths.js";
import { mergeText } from "./merge.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "BlattBot",
  GIT_AUTHOR_EMAIL: "blattbot@localhost",
  GIT_COMMITTER_NAME: "BlattBot",
  GIT_COMMITTER_EMAIL: "blattbot@localhost",
};

function git(dir: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: dir,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", GIT_LITERAL_PATHSPECS: "1", ...env },
      },
      (err, stdout, stderr) => {
        if (err) rejectPromise(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim()}`));
        else resolvePromise(String(stdout));
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function blob(dir: string, rev: string, path: string): Promise<Buffer | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["cat-file", "blob", `${rev}:${path}`],
      { cwd: dir, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => resolvePromise(err ? null : Buffer.from(stdout)),
    );
  });
}

async function headSha(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Commit the whole worktree as it is now and return the commit id. The parent
 * is `parent` when given, else HEAD (none in a repository without commits).
 */
export async function snapshotTree(dir: string, message: string, parent?: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "blattbot-snapshot-"));
  const index = join(tmp, "index");
  try {
    // Starting from a copy of the real index reuses its stat cache, so
    // unchanged files are not hashed again. git replaces the index by
    // rename, so a copy is always one complete version of it.
    const real = resolve(dir, (await git(dir, ["rev-parse", "--git-path", "index"])).trim());
    if (existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    await git(dir, ["add", "-A"], env);
    const tree = (await git(dir, ["write-tree"], env)).trim();
    const base = parent ?? (await headSha(dir));
    return (await git(dir, ["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", message], IDENTITY)).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary?: boolean;
}

/** The files that differ between two snapshots, with line counts. */
export async function changedFiles(dir: string, from: string, to: string): Promise<FileChange[]> {
  const status = new Map<string, FileChange["status"]>();
  const names = (await git(dir, ["diff", "--name-status", "--no-renames", "-z", from, to])).split("\0");
  for (let i = 0; i + 1 < names.length; i += 2) {
    const code = names[i];
    if (!code) continue;
    status.set(names[i + 1], code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified");
  }
  const out: FileChange[] = [];
  for (const record of (await git(dir, ["diff", "--numstat", "--no-renames", "-z", from, to])).split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!m) continue;
    const binary = m[1] === "-";
    out.push({
      path: m[3],
      status: status.get(m[3]) ?? "modified",
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      ...(binary ? { binary: true } : {}),
    });
  }
  return out;
}

/** Unified diff between two snapshots, in the shape the Proof view renders. */
export function diffBetween(dir: string, from: string, to: string): Promise<string> {
  return git(dir, ["diff", from, to]);
}

// ---- Turns -------------------------------------------------------------------

const TURN_PREFIX = "refs/blattbot/turns/";
/** Turn checkpoints kept per project; older ones are deleted. */
export const TURN_KEEP = 50;
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** "<chatId>.<n>" — the id routes and transcripts use for one turn. */
export function formatTurnRef(chatId: string, n: number): string {
  return `${chatId}.${n}`;
}

export function parseTurnRef(turnRef: string): { chatId: string; n: number } | null {
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{1,9})$/.exec(turnRef);
  return m ? { chatId: m[1], n: Number(m[2]) } : null;
}

function turnRefName(chatId: string, n: number, side: "before" | "after"): string {
  if (!CHAT_ID.test(chatId)) throw new Error(`invalid chat id: ${chatId}`);
  return `${TURN_PREFIX}${chatId}/${n}-${side}`;
}

async function resolveRef(dir: string, ref: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

/** The first free turn number for a chat, at least `min`. */
export async function freeTurnNumber(dir: string, chatId: string, min: number): Promise<number> {
  let n = Math.max(1, min);
  while (await resolveRef(dir, turnRefName(chatId, n, "before"))) n++;
  return n;
}

/** Snapshot the tree a turn starts from. */
export async function beginTurnCheckpoint(dir: string, chatId: string, n: number): Promise<string> {
  const sha = await snapshotTree(dir, `BlattBot checkpoint: before turn ${formatTurnRef(chatId, n)}`);
  await git(dir, ["update-ref", turnRefName(chatId, n, "before"), sha]);
  return sha;
}

export interface TurnCheckpoint {
  turnRef: string;
  beforeSha: string;
  afterSha: string;
  files: FileChange[];
}

/** Snapshot the tree a turn left behind; returns what the turn changed. */
export async function endTurnCheckpoint(dir: string, chatId: string, n: number, beforeSha: string): Promise<TurnCheckpoint> {
  const afterSha = await snapshotTree(dir, `BlattBot checkpoint: after turn ${formatTurnRef(chatId, n)}`, beforeSha);
  await git(dir, ["update-ref", turnRefName(chatId, n, "after"), afterSha]);
  return { turnRef: formatTurnRef(chatId, n), beforeSha, afterSha, files: await changedFiles(dir, beforeSha, afterSha) };
}

/** Both snapshots of a turn, or null when it was never recorded or was pruned. */
export async function turnShas(dir: string, turnRef: string): Promise<{ before: string; after: string } | null> {
  const parsed = parseTurnRef(turnRef);
  if (!parsed) return null;
  const before = await resolveRef(dir, turnRefName(parsed.chatId, parsed.n, "before"));
  const after = await resolveRef(dir, turnRefName(parsed.chatId, parsed.n, "after"));
  return before && after ? { before, after } : null;
}

async function deleteRefs(dir: string, refs: string[]): Promise<void> {
  if (refs.length === 0) return;
  await git(dir, ["update-ref", "--stdin"], {}, refs.map((r) => `delete ${r}\n`).join(""));
}

/** Keep the newest `keep` turns of the project (both refs of a turn go together). */
export async function pruneTurnRefs(dir: string, keep = TURN_KEEP): Promise<void> {
  const turns = new Map<string, { refs: string[]; date: number; n: number }>();
  const out = await git(dir, ["for-each-ref", "--format=%(refname)%09%(creatordate:unix)", TURN_PREFIX]);
  for (const line of out.split("\n")) {
    const m = /^(refs\/blattbot\/turns\/[^/]+\/(\d+))-(?:before|after)\t(\d+)$/.exec(line.trim());
    if (!m) continue;
    const turn = turns.get(m[1]) ?? { refs: [], date: 0, n: Number(m[2]) };
    turn.refs.push(line.split("\t")[0]);
    turn.date = Math.max(turn.date, Number(m[3]));
    turns.set(m[1], turn);
  }
  const ordered = [...turns.values()].sort((a, b) => b.date - a.date || b.n - a.n);
  await deleteRefs(dir, ordered.slice(keep).flatMap((t) => t.refs));
}

/** Drop every checkpoint of one chat (the chat was deleted). */
export async function deleteChatTurnRefs(dir: string, chatId: string): Promise<void> {
  if (!CHAT_ID.test(chatId)) return;
  const out = await git(dir, ["for-each-ref", "--format=%(refname)", `${TURN_PREFIX}${chatId}/`]);
  await deleteRefs(dir, out.split("\n").filter(Boolean));
}

// ---- Reverting a change against the current worktree -------------------------------

export interface ReverseResult {
  /** Files set back exactly (nothing changed them since). */
  restored: string[];
  /** Files merged: later edits to other lines were kept. */
  merged: string[];
  /** Files written with conflict markers — both sides changed the same lines. */
  conflicts: string[];
  /** Files left alone, with the reason. */
  skipped: { path: string; reason: string }[];
}

export interface ReverseLabels {
  /** Names the version being restored in conflict markers. */
  target: string;
  /** Names the version being undone. */
  undone: string;
}

const isRegularMode = (mode: string) => mode === "000000" || mode === "100644" || mode === "100755";

function readCurrent(abs: string): Buffer | null | "other" {
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return "other";
    return readFileSync(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
}

/** Remove now-empty directories between a deleted file and the project root. */
function pruneEmptyDirs(root: string, from: string): void {
  let current = from;
  while (current !== root && current.startsWith(root + sep)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function writeTarget(dir: string, abs: string, content: Buffer | null, mode: string): void {
  if (content === null) {
    rmSync(abs, { force: true });
    pruneEmptyDirs(dir, dirname(abs));
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mode === "100755") {
    try {
      chmodSync(abs, 0o755);
    } catch {
      /* not supported here */
    }
  }
}

/**
 * Bring the files that differ between snapshots `from` and `to` back to their
 * `to` version in the CURRENT worktree. Per file, a three-way merge with
 * base = from, ours = the worktree now, theirs = to: a file nobody touched
 * since is restored exactly; later edits elsewhere in a file are kept;
 * overlapping edits become conflict markers. Binary files and files deleted
 * or replaced since are left alone and reported.
 */
export async function reverseChanges(dir: string, from: string, to: string, labels: ReverseLabels): Promise<ReverseResult> {
  const result: ReverseResult = { restored: [], merged: [], conflicts: [], skipped: [] };
  const raw = (await git(dir, ["diff", "--raw", "--no-renames", "-z", from, to])).split("\0");
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) /.exec(raw[i]);
    const path = raw[i + 1];
    if (!meta || !path) continue;
    const [, fromMode, toMode] = meta;
    if (!isRegularMode(fromMode) || !isRegularMode(toMode)) {
      result.skipped.push({ path, reason: "not a regular file" });
      continue;
    }
    const abs = resolve(dir, path);
    if (!abs.startsWith(dir + sep) || abs.startsWith(join(dir, ".git") + sep)) {
      result.skipped.push({ path, reason: "outside the project" });
      continue;
    }
    try {
      assertNoSymlinkPath(dir, abs);
    } catch {
      result.skipped.push({ path, reason: "a symbolic link is in the way" });
      continue;
    }
    const base = fromMode === "000000" ? null : await blob(dir, from, path);
    const target = toMode === "000000" ? null : await blob(dir, to, path);
    const current = readCurrent(abs);
    if (current === "other") {
      result.skipped.push({ path, reason: "replaced by a folder or link since" });
      continue;
    }
    const same = (a: Buffer | null, b: Buffer | null) => (a === null ? b === null : b !== null && a.equals(b));
    if (same(current, target)) continue;
    if (same(current, base)) {
      writeTarget(dir, abs, target, toMode);
      result.restored.push(path);
      continue;
    }
    if (current === null) {
      result.skipped.push({ path, reason: "deleted since" });
      continue;
    }
    const merged = await mergeText(base ?? Buffer.alloc(0), current, target ?? Buffer.alloc(0), {
      ours: "current",
      base: labels.undone,
      theirs: labels.target,
    });
    if (!merged) {
      result.skipped.push({ path, reason: "binary file changed since" });
      continue;
    }
    // The undone side added the file and the merge leaves nothing: remove it.
    writeTarget(dir, abs, merged.content.length === 0 && target === null ? null : merged.content, toMode);
    if (merged.conflicts > 0) result.conflicts.push(path);
    else result.merged.push(path);
  }
  return result;
}

/** Undo one turn in the current worktree. */
export async function undoTurn(dir: string, turnRef: string): Promise<ReverseResult | null> {
  const shas = await turnShas(dir, turnRef);
  if (!shas) return null;
  return reverseChanges(dir, shas.after, shas.before, { undone: "after the turn", target: "before the turn" });
}

// ---- Discards ----------------------------------------------------------------

const DISCARD_PREFIX = "refs/blattbot/discard/";
/** Discard checkpoints kept per project. */
export const DISCARD_KEEP = 20;
const DISCARD_ID = /^\d{13}-[0-9a-f]{6}$/;

export function isDiscardId(id: string): boolean {
  return DISCARD_ID.test(id);
}

export interface DiscardCheckpoint<T> {
  result: T | null;
  /** Set when the operation threw away something that can be restored. */
  discardId?: string;
  files?: FileChange[];
}

/**
 * Run a discard (reject all / one file / one hunk) with a restore point:
 * the tree is snapshotted before and after, and the pair is kept under
 * refs/blattbot/discard/<id>. `op` returning null means it did nothing.
 * Must run inside the project lock, like the discard itself.
 */
export async function withDiscardCheckpoint<T>(dir: string, op: () => Promise<T | null>): Promise<DiscardCheckpoint<T>> {
  const before = await snapshotTree(dir, "BlattBot checkpoint: before discard");
  const result = await op();
  if (result === null) return { result };
  const after = await snapshotTree(dir, "BlattBot checkpoint: after discard", before);
  const files = await changedFiles(dir, after, before);
  if (files.length === 0) return { result };
  const discardId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  await git(dir, ["update-ref", `${DISCARD_PREFIX}${discardId}`, after]);
  await pruneDiscardRefs(dir);
  return { result, discardId, files };
}

async function pruneDiscardRefs(dir: string, keep = DISCARD_KEEP): Promise<void> {
  const out = await git(dir, ["for-each-ref", "--format=%(refname)", DISCARD_PREFIX]);
  // Ids start with a millisecond timestamp, so name order is age order.
  const refs = out.split("\n").filter(Boolean).sort().reverse();
  await deleteRefs(dir, refs.slice(keep));
}

/** Put back what a discard threw away; null when the restore point is gone. */
export async function restoreDiscard(dir: string, discardId: string): Promise<ReverseResult | null> {
  if (!isDiscardId(discardId)) return null;
  const ref = `${DISCARD_PREFIX}${discardId}`;
  const after = await resolveRef(dir, ref);
  const before = after ? await resolveRef(dir, `${after}^1`) : null;
  if (!after || !before) return null;
  const result = await reverseChanges(dir, after, before, { undone: "after the discard", target: "discarded" });
  await deleteRefs(dir, [ref]);
  return result;
}
