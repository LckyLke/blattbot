/**
 * Project history: the mirror's commits classified by where they came from
 * (Overleaf or the git remote, your approvals, local-only commits, reverts),
 * one commit's diff, the force-approve backups under
 * .git/blattbot/remote-backup, and reverting a commit.
 *
 * A revert never commits or pushes: it writes the reverse of the commit into
 * the worktree as NEW PENDING changes (a three-way merge per file, so later
 * edits stay), and the user reviews and approves them in Proof like any
 * other edit — the normal Overleaf conflict check included.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { projectDir, type Project } from "./config.js";
import * as git from "./git.js";
import { mergeText } from "./merge.js";
import { appendEvent, ensureActiveChat } from "./chats.js";

export type CommitKind = "sync" | "approve" | "local" | "revert" | "other";
export type HistoryFilter = "all" | "sync" | "mine";

export const TRAILER_KIND = "BlattBot-Kind";
export const TRAILER_CHAT = "BlattBot-Chat";
export const TRAILER_REVERTS = "BlattBot-Reverts";

/** An error with the HTTP status the route should answer with. */
export class HistoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

export interface HistoryCommit {
  sha: string;
  short: string;
  kind: CommitKind;
  subject: string;
  /** The message after the subject line, trailers removed ("" when none). */
  body: string;
  author: { name: string; email: string };
  /** Author date, ISO 8601. */
  time: string;
  parents: string[];
  files: git.CommitFileStat[];
  additions: number;
  deletions: number;
  /** The chat an approval came from (BlattBot-Chat trailer). */
  chatId?: string;
  /** Commits this one reverts (BlattBot-Reverts trailer). */
  reverts?: string[];
}

// ---- Commit messages and trailers ----

/** Append BlattBot trailers to a commit message, as their own paragraph. */
export function withTrailers(message: string, trailers: Record<string, string | undefined>): string {
  const lines = Object.entries(trailers)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
    .map(([key, value]) => `${key}: ${value.replace(/\s+/g, " ").trim()}`);
  const text = message.trimEnd();
  return lines.length > 0 ? `${text}\n\n${lines.join("\n")}` : text;
}

/** Split a commit message into its text and the trailing BlattBot trailer block. */
export function splitTrailers(message: string): { text: string; trailers: Record<string, string> } {
  const trimmed = message.replace(/\s+$/, "");
  const at = trimmed.lastIndexOf("\n\n");
  if (at < 0) return { text: trimmed, trailers: {} };
  const lines = trimmed.slice(at + 2).split("\n");
  const trailers: Record<string, string> = {};
  for (const line of lines) {
    const m = /^(BlattBot-[A-Za-z-]+):\s*(.*)$/.exec(line.trim());
    if (!m) return { text: trimmed, trailers: {} };
    trailers[m[1]] = m[2].trim();
  }
  return { text: trimmed.slice(0, at).trimEnd(), trailers };
}

// ---- Classification ----

export interface ClassifyContext {
  projectKind: Project["kind"];
  /** Commits not on the upstream branch yet (git projects). */
  unpushed: Set<string>;
  /** Whose approvals these are (the user's git identity, or BlattBot's). */
  approver: git.CommitAuthor;
}

interface ClassifyInput {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  subject: string;
  trailers: Record<string, string>;
}

/**
 * Where a commit came from. Commits BlattBot makes carry a BlattBot-Kind
 * trailer; older ones (and commits pulled from a git remote) are judged by
 * their author and subject.
 */
export function classifyCommit(c: ClassifyInput, ctx: ClassifyContext): CommitKind {
  if (c.parents.length > 1) return "other";
  const kind = c.trailers[TRAILER_KIND];
  if (kind === "revert") return "revert";
  if (kind === "sync") return "sync";
  if (kind === "local") return "local";
  if (kind === "approve") return ctx.projectKind === "local" || ctx.unpushed.has(c.sha) ? "local" : "approve";
  if (/^(initial )?sync from overleaf\b/i.test(c.subject) || c.authorName === git.OVERLEAF_AUTHOR.name) return "sync";
  if (ctx.unpushed.has(c.sha)) return "local";
  if (/^Revert\b/.test(c.subject)) return ctx.projectKind === "local" ? "local" : "revert";
  const email = c.authorEmail.toLowerCase();
  const byBlattBot = email === git.BLATTBOT_AUTHOR.email || /^(BlattBot edit|Publish to Overleaf)\b/.test(c.subject);
  const byMe = email === ctx.approver.email.toLowerCase();
  if (ctx.projectKind === "local") return "local";
  if (byBlattBot || byMe) return c.subject === "New project" ? "local" : "approve";
  // A commit someone else pushed to the git remote.
  if (ctx.projectKind === "git") return "sync";
  return "other";
}

export function matchesFilter(kind: CommitKind, filter: HistoryFilter): boolean {
  if (filter === "sync") return kind === "sync";
  if (filter === "mine") return kind === "approve" || kind === "revert" || kind === "local";
  return true;
}

function toHistoryCommit(raw: git.RawCommit, ctx: ClassifyContext): HistoryCommit {
  const { text, trailers } = splitTrailers(raw.body);
  const newline = text.indexOf("\n");
  const subject = (newline < 0 ? text : text.slice(0, newline)).trim();
  const body = newline < 0 ? "" : text.slice(newline + 1).trim();
  const kind = classifyCommit(
    { sha: raw.sha, parents: raw.parents, authorName: raw.authorName, authorEmail: raw.authorEmail, subject, trailers },
    ctx,
  );
  const reverts = trailers[TRAILER_REVERTS]?.split(/\s+/).filter((s) => /^[0-9a-f]{4,64}$/.test(s));
  return {
    sha: raw.sha,
    short: raw.sha.slice(0, 7),
    kind,
    subject: subject || "(no message)",
    body,
    author: { name: raw.authorName, email: raw.authorEmail },
    time: raw.authorDate,
    parents: raw.parents,
    files: raw.files,
    additions: raw.files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: raw.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    ...(trailers[TRAILER_CHAT] ? { chatId: trailers[TRAILER_CHAT] } : {}),
    ...(reverts?.length ? { reverts } : {}),
  };
}

async function classifyContext(project: Project, dir: string): Promise<ClassifyContext> {
  return {
    projectKind: project.kind,
    unpushed: project.kind === "git" ? await git.unpushedCommits(dir) : new Set(),
    approver: await git.approverIdentity(),
  };
}

// ---- Listing ----

export interface HistoryPage {
  /** The commit the listing starts from; pass it back with `offset` for the next page. */
  head: string | null;
  commits: HistoryCommit[];
  /** Offset of the next page, or null when the history is exhausted. */
  nextOffset: number | null;
}

const SCAN_BATCH = 100;
/** Upper bound on commits read per request while filtering. */
const SCAN_MAX = 2000;

/**
 * Commits newest first. Pages are stable: the first page fixes `head`, and
 * later pages pass it back with the offset (commits scanned so far), so new
 * commits arriving meanwhile never shift or repeat entries.
 */
export async function listHistory(
  project: Project,
  opts: { limit?: number; offset?: number; head?: string; filter?: HistoryFilter } = {},
): Promise<HistoryPage> {
  const dir = projectDir(project.id);
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 30)));
  const filter = opts.filter ?? "all";
  const head = await git.resolveCommit(dir, opts.head ?? "HEAD");
  if (!head) {
    if (opts.head) throw new HistoryError("unknown commit", 404);
    return { head: null, commits: [], nextOffset: null };
  }
  const ctx = await classifyContext(project, dir);
  const total = await git.countCommits(dir, head);
  let offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const commits: HistoryCommit[] = [];
  let scanned = 0;
  while (commits.length < limit && scanned < SCAN_MAX && offset < total) {
    const batch = await git.logCommits(dir, { rev: head, skip: offset, max: SCAN_BATCH });
    if (batch.length === 0) break;
    for (const raw of batch) {
      offset++;
      scanned++;
      const commit = toHistoryCommit(raw, ctx);
      if (matchesFilter(commit.kind, filter)) commits.push(commit);
      if (commits.length >= limit) break;
    }
  }
  return { head, commits, nextOffset: offset < total ? offset : null };
}

/** How many commits from Overleaf/the remote landed after `since` (the last one the user saw). */
export async function unreadSince(project: Project, since?: string): Promise<{ head: string | null; unread: number }> {
  const dir = projectDir(project.id);
  const head = await git.resolveCommit(dir, "HEAD");
  if (!head || !since) return { head, unread: 0 };
  const seen = await git.resolveCommit(dir, since);
  if (!seen || seen === head || !(await git.isAncestor(dir, seen, head))) return { head, unread: 0 };
  const ctx = await classifyContext(project, dir);
  const commits = await git.logCommits(dir, { rev: `${seen}..${head}`, max: 500 });
  return { head, unread: commits.filter((raw) => toHistoryCommit(raw, ctx).kind === "sync").length };
}

/** Diffs bigger than this are cut at a file boundary. */
const MAX_DIFF_BYTES = 1_500_000;

export function truncateDiff(diff: string, max = MAX_DIFF_BYTES): { diff: string; truncated: boolean } {
  if (diff.length <= max) return { diff, truncated: false };
  const head = diff.slice(0, max);
  const cut = head.lastIndexOf("\ndiff --git ");
  return { diff: cut > 0 ? head.slice(0, cut + 1) : head.slice(0, head.lastIndexOf("\n") + 1), truncated: true };
}

/** One commit with its unified diff against its first parent. */
export async function commitDetail(
  project: Project,
  rev: string,
): Promise<{ commit: HistoryCommit; diff: string; truncated: boolean }> {
  const dir = projectDir(project.id);
  const sha = await git.resolveCommit(dir, rev);
  if (!sha) throw new HistoryError("unknown commit", 404);
  const [raw] = await git.logCommits(dir, { rev: sha, max: 1 });
  if (!raw) throw new HistoryError("unknown commit", 404);
  const commit = toHistoryCommit(raw, await classifyContext(project, dir));
  return { commit, ...truncateDiff(await git.commitDiff(dir, sha, raw.parents[0])) };
}

// ---- Force-approve backups ----

export interface BackupFile {
  path: string;
  size: number;
}

export interface Backup {
  stamp: string;
  /** When the backup was taken, ISO 8601 (from the stamp). */
  at: string;
  files: BackupFile[];
}

/** Stamps are ISO times with ":" replaced by "-" (see sync.ts approve). */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z$/;

function backupRoot(dir: string): string {
  return join(dir, ".git", "blattbot", "remote-backup");
}

function stampTime(stamp: string): string {
  return stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
}

function walkFiles(root: string, dir = root): BackupFile[] {
  const files: BackupFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, abs));
    else if (entry.isFile()) files.push({ path: relative(root, abs).split(sep).join("/"), size: statSync(abs).size });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every force-approve backup of the project, newest first. */
export function listBackups(dir: string): Backup[] {
  let entries: string[];
  try {
    entries = readdirSync(backupRoot(dir));
  } catch {
    return [];
  }
  const backups: Backup[] = [];
  for (const stamp of entries) {
    if (!STAMP_RE.test(stamp)) continue;
    const abs = join(backupRoot(dir), stamp);
    try {
      if (!lstatSync(abs).isDirectory()) continue;
      backups.push({ stamp, at: stampTime(stamp), files: walkFiles(abs) });
    } catch {
      /* vanished meanwhile */
    }
  }
  return backups.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/** One backed-up file's bytes, or null for an unknown stamp/path (never outside the backup). */
export function readBackupFile(dir: string, stamp: string, path: string): Buffer | null {
  if (!STAMP_RE.test(stamp) || !path || path.includes("\0")) return null;
  const root = resolve(backupRoot(dir), stamp);
  const abs = resolve(root, path);
  if (!abs.startsWith(root + sep)) return null;
  try {
    const st = lstatSync(abs);
    return st.isFile() ? readFileSync(abs) : null;
  } catch {
    return null;
  }
}

// ---- Pending reverts ----

/** A revert written into the worktree that has not been approved yet. */
export interface PendingRevert {
  sha: string;
  short: string;
  subject: string;
  /** Paths the revert changed. */
  paths: string[];
  /** Paths it left with conflict markers. */
  conflictPaths: string[];
  at: string;
}

function revertsFile(dir: string): string {
  return join(dir, ".git", "blattbot", "pending-reverts.json");
}

function readReverts(dir: string): PendingRevert[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(revertsFile(dir), "utf8"));
    return Array.isArray(raw) ? (raw as PendingRevert[]).filter((r) => r && typeof r.sha === "string" && Array.isArray(r.paths)) : [];
  } catch {
    return [];
  }
}

function writeReverts(dir: string, reverts: PendingRevert[]): void {
  if (reverts.length === 0) {
    rmSync(revertsFile(dir), { force: true });
    return;
  }
  mkdirSync(dirname(revertsFile(dir)), { recursive: true });
  writeFileSync(revertsFile(dir), JSON.stringify(reverts, null, 2));
}

/**
 * Reverts still (partly) pending. One whose paths no longer have pending
 * changes (approved or discarded) is forgotten.
 */
export async function pendingReverts(dir: string): Promise<PendingRevert[]> {
  const stored = readReverts(dir);
  if (stored.length === 0) return [];
  const pending = new Set(await git.pendingPathsReadOnly(dir));
  const live = stored.filter((r) => r.paths.some((p) => pending.has(p)));
  if (live.length !== stored.length) writeReverts(dir, live);
  return live;
}

/** The default commit message for approving pending reverts. */
export function revertMessage(reverts: Pick<PendingRevert, "subject">[]): string {
  if (reverts.length === 0) return "";
  if (reverts.length > 1) return `Revert ${reverts.length} earlier changes`;
  const subject = reverts[0].subject.length > 60 ? `${reverts[0].subject.slice(0, 59)}…` : reverts[0].subject;
  return `Revert "${subject}"`;
}

// ---- Reverting a commit ----

export interface RevertConflict {
  path: string;
  /** What happened: conflict markers were written, or the file was left as it is. */
  reason: string;
  markers: boolean;
}

export interface RevertResult {
  sha: string;
  short: string;
  subject: string;
  /** Paths written or deleted. */
  changed: string[];
  conflicts: RevertConflict[];
  /** Suggested commit message for the approval. */
  message: string;
}

export type FileRevert =
  | { action: "none" }
  | { action: "delete" }
  | { action: "write"; content: Buffer; conflicts: number }
  | { action: "keep"; reason: string };

const same = (a: Buffer | null, b: Buffer | null) => (a && b ? a.equals(b) : !a && !b);

/**
 * Undo one file's change: `base` is the commit's version, `theirs` its
 * parent's (null = absent) and `ours` the current worktree. Edits made since
 * the commit stay; overlapping ones become conflict blocks.
 */
export async function revertFile(
  base: Buffer | null,
  ours: Buffer | null,
  theirs: Buffer | null,
  short: string,
): Promise<FileRevert> {
  if (same(ours, theirs)) return { action: "none" };
  if (same(ours, base)) return theirs ? { action: "write", content: theirs, conflicts: 0 } : { action: "delete" };
  if (!ours) return { action: "keep", reason: "deleted since this commit — not restored" };
  if (!theirs) return { action: "keep", reason: "edited since this commit added it — not deleted" };
  const merged = await mergeText(base ?? Buffer.alloc(0), ours, theirs, {
    ours: "current",
    base: `${short} (reverted)`,
    theirs: `before ${short}`,
  });
  if (!merged) return { action: "keep", reason: "binary file changed since this commit — not reverted" };
  return { action: "write", content: merged.content, conflicts: merged.conflicts };
}

/** Regular files only: symlinks and submodules are never rewritten. */
const REGULAR = new Set(["000000", "100644", "100755"]);

/**
 * Apply the reverse of commit `rev` to the worktree as pending changes. The
 * caller holds the project lock and has checked that no agent turn runs.
 */
export async function revertCommit(project: Project, rev: string): Promise<RevertResult> {
  const dir = projectDir(project.id);
  const sha = await git.resolveCommit(dir, rev);
  const head = await git.resolveCommit(dir, "HEAD");
  if (!sha || !head) throw new HistoryError("unknown commit", 404);
  if (!(await git.isAncestor(dir, sha, head))) {
    throw new HistoryError("That commit is not part of this project's current history.", 404);
  }
  const [raw] = await git.logCommits(dir, { rev: sha, max: 1 });
  if (!raw) throw new HistoryError("unknown commit", 404);
  const commit = toHistoryCommit(raw, await classifyContext(project, dir));
  if (raw.parents.length > 1) {
    throw new HistoryError(
      "This is a merge commit — reverting merges is not supported. Revert the individual commits instead.",
      422,
    );
  }
  if (raw.parents.length === 0) {
    throw new HistoryError("This is the project's first commit — reverting it would delete every file.", 422);
  }
  const parent = raw.parents[0];
  const root = resolve(dir);
  const changed: string[] = [];
  const conflicts: RevertConflict[] = [];
  for (const change of await git.treeChanges(dir, parent, sha)) {
    const { path } = change;
    if (!REGULAR.has(change.oldMode) || !REGULAR.has(change.newMode)) {
      conflicts.push({ path, reason: "not a regular file — left unchanged", markers: false });
      continue;
    }
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) continue;
    let ours: Buffer | null = null;
    try {
      const st = lstatSync(target);
      if (!st.isFile()) {
        conflicts.push({ path, reason: "no longer a regular file here — left unchanged", markers: false });
        continue;
      }
      ours = readFileSync(target);
    } catch {
      /* absent now */
    }
    const base = change.status === "D" ? null : await git.readBlob(dir, sha, path);
    const theirs = change.status === "A" ? null : await git.readBlob(dir, parent, path);
    const outcome = await revertFile(base, ours, theirs, commit.short);
    if (outcome.action === "none") continue;
    if (outcome.action === "keep") {
      conflicts.push({ path, reason: outcome.reason, markers: false });
      continue;
    }
    if (outcome.action === "delete") {
      rmSync(target, { force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, outcome.content);
      if (outcome.conflicts > 0) {
        conflicts.push({
          path,
          reason: `${outcome.conflicts} conflict${outcome.conflicts === 1 ? "" : "s"} with later edits — resolve the <<<<<<< blocks`,
          markers: true,
        });
      }
    }
    changed.push(path);
  }
  if (changed.length > 0) {
    const others = (await pendingReverts(dir)).filter((r) => r.sha !== sha);
    writeReverts(dir, [
      ...others,
      {
        sha,
        short: commit.short,
        subject: commit.subject,
        paths: changed,
        conflictPaths: conflicts.filter((c) => c.markers).map((c) => c.path),
        at: new Date().toISOString(),
      },
    ]);
  }
  const reverts = await pendingReverts(dir);
  return {
    sha,
    short: commit.short,
    subject: commit.subject,
    changed,
    conflicts,
    message: revertMessage(reverts.length > 0 ? reverts : [commit]),
  };
}

// ---- Approvals: trailers, results, chat notices ----

/** Paths a unified patch touches (both sides of its `diff --git` headers). */
function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.*) b\/(.*)$/gm)) {
    paths.add(m[1]);
    paths.add(m[2]);
  }
  return [...paths];
}

const hasConflictMarkers = (text: string) => /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text);

export interface ApprovalPlan {
  /** Paths this approval covers. */
  paths: string[];
  trailers: Record<string, string>;
  chatId?: string;
  headBefore: string | null;
  backupsBefore: Set<string>;
}

/**
 * Before an approval (under the project lock): its trailers, and the state
 * needed to describe its result afterwards. Refuses to approve a revert's
 * unresolved conflict blocks.
 */
export async function planApproval(
  project: Project,
  selection?: { files?: string[]; patches?: string[] },
): Promise<ApprovalPlan> {
  const dir = projectDir(project.id);
  const paths = selection
    ? [...new Set([...(selection.files ?? []), ...(selection.patches ?? []).flatMap(patchPaths)])]
    : await git.changedPaths(dir);
  const covered = new Set(paths);
  const reverts = (await pendingReverts(dir)).filter((r) => r.paths.some((p) => covered.has(p)));
  const unresolved = reverts
    .flatMap((r) => r.conflictPaths)
    .filter((p, i, all) => covered.has(p) && all.indexOf(p) === i)
    .filter((p) => {
      try {
        return hasConflictMarkers(readFileSync(join(dir, p), "utf8"));
      } catch {
        return false;
      }
    });
  if (unresolved.length > 0) {
    throw new HistoryError(
      `Resolve the conflict markers in ${unresolved.join(", ")} first — the revert left <<<<<<< blocks there.`,
      409,
    );
  }
  let chatId: string | undefined;
  try {
    chatId = ensureActiveChat(project.id).id;
  } catch {
    /* no chat registry yet */
  }
  const kind = reverts.length > 0 ? "revert" : project.kind === "local" ? "local" : "approve";
  return {
    paths,
    chatId,
    trailers: {
      [TRAILER_KIND]: kind,
      ...(chatId ? { [TRAILER_CHAT]: chatId } : {}),
      ...(reverts.length > 0 ? { [TRAILER_REVERTS]: reverts.map((r) => r.sha).join(" ") } : {}),
    },
    headBefore: await git.resolveCommit(dir, "HEAD"),
    backupsBefore: new Set(listBackups(dir).map((b) => b.stamp)),
  };
}

export interface ApprovalNotes {
  /** Short id of the commit the approval made. */
  commit?: string;
  /** What the approval covered and is no longer pending. */
  files: string[];
  /** The backup a forced approval took of Overleaf's versions. */
  backup?: { stamp: string; files: string[] };
}

/** After a successful approval (still under the lock): its commit, files and backup. */
export async function finishApproval(
  project: Project,
  plan: ApprovalPlan,
  result: { pending?: string[] },
): Promise<ApprovalNotes> {
  const dir = projectDir(project.id);
  const notes: ApprovalNotes = {
    files: plan.paths.filter((p) => !(result.pending ?? []).includes(p)),
  };
  try {
    const range = plan.headBefore ? `${plan.headBefore}..HEAD` : "HEAD";
    const made = (await git.logCommits(dir, { rev: range, max: 20 })).find(
      (raw) => splitTrailers(raw.body).trailers[TRAILER_KIND] === plan.trailers[TRAILER_KIND],
    );
    if (made) notes.commit = made.sha.slice(0, 7);
    if (!made) notes.files = [];
  } catch {
    /* the notes are informational */
  }
  const backup = listBackups(dir).find((b) => !plan.backupsBefore.has(b.stamp));
  if (backup) notes.backup = { stamp: backup.stamp, files: backup.files.map((f) => f.path) };
  await pendingReverts(dir).catch(() => []);
  return notes;
}

/** Persist an event to the project's active chat transcript (best effort). */
export function recordChatEvent(projectId: string, event: { type: string; [key: string]: unknown }, chatId?: string): void {
  try {
    appendEvent(projectId, chatId ?? ensureActiveChat(projectId).id, event);
  } catch {
    try {
      appendEvent(projectId, ensureActiveChat(projectId).id, event);
    } catch {
      /* persistence must never fail the action */
    }
  }
}
