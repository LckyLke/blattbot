/**
 * Sync dispatch: every project is one of
 *  - kind "git":      a clone of a real git remote (Overleaf git bridge, GitHub, …)
 *  - kind "overleaf": a local git mirror of an Overleaf project synced over the
 *                     cookie-authenticated web interface (Community Edition etc.)
 *  - kind "local":    a standalone local repo with no remote; approvals just
 *                     commit. Can be published to an Overleaf account later,
 *                     which converts it to kind "overleaf".
 *
 * Overleaf sessions come from the accounts store. When one expires mid-operation
 * we silently try to revive it from the user's browser cookies; only if that
 * fails does the account flip to "disconnected" (it is never removed).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir, updateProject, type Project } from "./config.js";
import * as git from "./git.js";
import { CONFLICT_LABELS, describeConflict, hasConflictMarkers, type RemoteConflict } from "./conflicts.js";
import { looksBinary, mergeText } from "./merge.js";
import { OverleafAuthError, OverleafClient, type RemoteCompileResult } from "./overleaf/olclient.js";
import {
  applyRemoteVersions,
  mergeRemoteChanges,
  pushAll,
  pushChanges,
  readWorktree,
  scanRemoteDrift,
  syncIn as olSyncIn,
  unpackZip,
  type PushResult,
  type RebasedFile,
  type RemoteMergeResult,
} from "./overleaf/olsync.js";
import { cookieForProject, getAccount, refreshFromBrowsers, updateAccount, type OlAccount } from "./accounts.js";

export type { ConflictHunk, RemoteConflict } from "./conflicts.js";

export function overleafClient(project: Project): OverleafClient {
  const cookie = cookieForProject(project);
  if (!project.overleafBaseUrl || !cookie) {
    throw new Error("project is missing Overleaf connection details");
  }
  return new OverleafClient(project.overleafBaseUrl, cookie);
}

/** Run an Overleaf operation, auto-refreshing the account session once on auth failure. */
async function withSession<T>(project: Project, fn: (client: OverleafClient) => Promise<T>): Promise<T> {
  try {
    return await fn(overleafClient(project));
  } catch (err) {
    if (!(err instanceof OverleafAuthError)) throw err;
    const account = project.accountId ? getAccount(project.accountId) : undefined;
    if (account && (await refreshFromBrowsers(account))) {
      return await fn(overleafClient(project));
    }
    if (account) updateAccount(account.id, { status: "disconnected" });
    const host = project.overleafBaseUrl ? new URL(project.overleafBaseUrl).hostname : "Overleaf";
    throw new Error(
      `The ${host} session has expired — reconnect the account in Settings, then try again.`,
    );
  }
}

export interface SyncResult {
  ok: boolean;
  detail?: string;
  /** overleaf kind: whether a sync commit was made. */
  changed?: boolean;
  /** Remote-changed paths whose Overleaf version came in while local edits were pending. */
  merged?: string[];
  /** Of `merged`: files with pending edits merged line by line; the edits stay pending on top. */
  rebased?: string[];
  /** Remote-changed paths left alone because their local edits overlap. */
  drift?: string[];
  /** What overlaps in each drift path (git kind: the files with conflict markers). */
  conflicts?: RemoteConflict[];
  /** Quick sync only: Overleaf showed no change since the last full sync, so nothing was downloaded. */
  skipped?: boolean;
  /** overleaf kind: when the last full sync ran, and Overleaf's lastUpdated it saw. */
  lastSyncAt?: string;
  remoteLastUpdated?: string;
}

export interface SyncOptions {
  /**
   * Skip the snapshot download when Overleaf's project list shows no change
   * since the last full sync (one small request instead of a project zip).
   */
  quick?: boolean;
}

/** A quick sync still downloads the full snapshot when the last full sync is older than this. */
export const FULL_SYNC_MAX_AGE_MS = 10 * 60_000;

/**
 * What the last full sync left behind: Overleaf's lastUpdated it saw, and
 * HEAD's tree once it held Overleaf's version of every file. Lives under
 * .git, outside the worktree and the diff.
 */
interface SyncState {
  lastUpdated: string;
  tree: string;
}

const syncStatePath = (dir: string) => join(dir, ".git", "blattbot", "sync-state.json");

function readSyncState(dir: string): SyncState | null {
  try {
    const state = JSON.parse(readFileSync(syncStatePath(dir), "utf8"));
    return typeof state?.lastUpdated === "string" && typeof state?.tree === "string" ? state : null;
  } catch {
    return null;
  }
}

function writeSyncState(dir: string, state: SyncState | null): void {
  const path = syncStatePath(dir);
  if (!state) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

/**
 * Overleaf's lastUpdated for the project, from the dashboard project list;
 * undefined when the list does not say. An expired session still throws, so
 * withSession can refresh it.
 */
async function listedLastUpdated(client: OverleafClient, remoteProjectId: string): Promise<string | undefined> {
  try {
    return (await client.listProjects()).find((p) => p.id === remoteProjectId)?.lastUpdated;
  } catch (err) {
    if (err instanceof OverleafAuthError) throw err;
    return undefined;
  }
}

/**
 * True when a full sync would change nothing: Overleaf reports the same
 * lastUpdated as the last full sync, that sync is recent, and HEAD still is
 * the tree it left. Any doubt means false.
 */
async function remoteUnchanged(project: Project, dir: string, listed: string | undefined): Promise<boolean> {
  if (!listed || listed !== project.remoteLastUpdated) return false;
  const age = Date.now() - Date.parse(project.lastSyncAt ?? "");
  if (!(age >= 0 && age < FULL_SYNC_MAX_AGE_MS)) return false;
  const state = readSyncState(dir);
  if (!state || state.lastUpdated !== listed) return false;
  try {
    return state.tree === (await git.revParse(dir, "HEAD^{tree}"));
  } catch {
    return false;
  }
}

/** Persist what we know about the remote, and keep the caller's copy current. */
function recordRemote(project: Project, patch: Pick<Project, "lastSyncAt" | "remoteLastUpdated">): void {
  updateProject(project.id, patch);
  Object.assign(project, patch);
}

/** Bring the working tree up to date with the remote (before an agent turn, on open, on demand). */
export async function syncIn(project: Project, opts: SyncOptions = {}): Promise<SyncResult> {
  const dir = projectDir(project.id);
  if (project.kind === "local") return { ok: true };
  if (project.kind === "overleaf") {
    const remoteId = project.overleafProjectId!;
    const outcome = await withSession(project, async (client) => {
      // Read BEFORE the snapshot: an edit landing during the download then
      // reads as newer next time, never as already seen.
      const listed = await listedLastUpdated(client, remoteId);
      if (opts.quick && (await remoteUnchanged(project, dir, listed))) return { listed, result: null };
      return { listed, result: await olSyncIn(client, remoteId, dir) };
    });
    const result = outcome.result;
    if (!result) {
      return { ok: true, skipped: true, lastSyncAt: project.lastSyncAt, remoteLastUpdated: project.remoteLastUpdated };
    }
    // A later quick sync may skip the download only while HEAD still is
    // this tree and Overleaf reports the same lastUpdated.
    const tree = result.inSync && outcome.listed ? await git.revParse(dir, "HEAD^{tree}") : null;
    writeSyncState(dir, tree ? { lastUpdated: outcome.listed!, tree } : null);
    recordRemote(project, { lastSyncAt: new Date().toISOString(), remoteLastUpdated: outcome.listed });
    const rebased = result.rebased ?? [];
    const plain = (result.merged ?? []).filter((p) => !rebased.includes(p));
    const parts: string[] = [];
    if (plain.length > 0) parts.push(`merged remote changes to: ${plain.join(", ")}`);
    else if (result.changed && rebased.length === 0) parts.push("picked up remote changes");
    if (rebased.length > 0) {
      parts.push(`merged Overleaf's edits to ${rebased.join(", ")} with your pending edits, line by line`);
    }
    if (result.drift?.length) {
      parts.push(
        `Overleaf has newer versions of: ${result.drift.join(", ")} — they overlap your local edits; review them in Proof`,
      );
    }
    return {
      ok: true,
      detail: parts.length > 0 ? parts.join("; ") : undefined,
      changed: result.changed,
      merged: result.merged,
      rebased: result.rebased,
      drift: result.drift,
      conflicts: result.conflicts,
      lastSyncAt: project.lastSyncAt,
      remoteLastUpdated: project.remoteLastUpdated,
    };
  }
  await moveRemoteCredentials(project);
  await clearResolvedConflicts(dir);
  const before = await git.revParse(dir, "HEAD");
  await git.pull(dir, project.token);
  const drift = await git.unmergedPaths(dir);
  return {
    ok: true,
    changed: before !== await git.revParse(dir, "HEAD"),
    drift,
    ...(drift.length ? { conflicts: drift.map((path) => ({ path, kind: "unmerged" as const })) } : {}),
    ...(drift.length ? { detail: `Git conflicts need resolving in: ${drift.join(", ")}. Your original local edits are also preserved in the Git stash.` } : {}),
  };
}

/** Files bigger than this are not scanned for conflict markers. */
const MARKER_SCAN_LIMIT = 8 * 1024 * 1024;

/** Of `paths`, the text files whose worktree version holds conflict markers. */
export function markedPaths(dir: string, paths: Iterable<string>): string[] {
  const marked: string[] = [];
  for (const path of new Set(paths)) {
    const content = readWorktree(dir, path);
    if (!content || content.length > MARKER_SCAN_LIMIT || looksBinary(content)) continue;
    if (hasConflictMarkers(content)) marked.push(path);
  }
  return marked;
}

/**
 * Git-bridge files a sync left with conflict markers (unmerged, or edited
 * since and still marked). An agent turn must not start on top of them.
 */
export async function conflictMarkerPaths(project: Project): Promise<string[]> {
  if ((project.kind ?? "git") !== "git") return [];
  const dir = projectDir(project.id);
  return markedPaths(dir, [...(await git.unmergedPaths(dir)), ...(await git.changedPaths(dir))]);
}

/**
 * An autostash conflict leaves index entries unmerged even after the user
 * removed the markers, and `git pull` refuses to run until they are cleared.
 * Unstage such resolved files (the worktree keeps the resolution as a
 * pending edit); files that still hold markers stay unmerged.
 */
async function clearResolvedConflicts(dir: string): Promise<void> {
  const resolved = (await git.unmergedPaths(dir)).filter((path) => {
    const content = readWorktree(dir, path);
    return content !== null && !looksBinary(content) && !hasConflictMarkers(content);
  });
  await git.resetIndexPaths(dir, resolved);
}

/**
 * Approval refused: the remote changed files that also have local edits, in
 * the same lines (or a side is binary or deleted). Each conflict carries what
 * overlaps (`hunks`), for the Proof view.
 */
export class ApproveConflictError extends Error {
  constructor(public readonly conflicts: RemoteConflict[]) {
    super(
      `Overleaf changed ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} you also edited — resolve or force-approve`,
    );
    this.name = "ApproveConflictError";
  }
}

export interface ApproveResult {
  pushed: boolean;
  uploaded?: string[];
  /** Of `uploaded`: docs edited in place (comments and history kept). */
  updatedInPlace?: string[];
  deleted?: string[];
  warnings?: string[];
  /** Remote-only changes absorbed into the mirror after the push. */
  absorbedRemote?: string[];
  /**
   * Files whose Overleaf changes were merged line by line with the local
   * edits: approved files before the push (the push carries both), and
   * pending files after it (their edits stay pending on top).
   */
  mergedRemote?: string[];
  /** Pending files Overleaf also changed whose edits overlap; left untouched. */
  drift?: string[];
  /** What overlaps in each drift file. */
  conflicts?: RemoteConflict[];
  /** Approved paths that did not reach the remote; they stay pending. */
  pending?: string[];
  /** Overleaf's lastUpdated re-read after the push. */
  remoteLastUpdated?: string;
}

export interface ApproveOptions {
  /** Overwrite every conflicting remote edit (their versions are backed up first). */
  force?: boolean;
  /** Overwrite only these conflicting files (backed up first); other conflicts still refuse. */
  forcePaths?: string[];
  /**
   * Approve only part of the pending changes: whole files and/or single hunks
   * (unified patches of the working diff). Everything else stays pending.
   */
  selection?: ApproveSelection;
}

export interface ApproveSelection {
  files?: string[];
  patches?: string[];
}

/** The selection no longer matches the pending changes (or is empty). */
export class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

/**
 * Conflicts = approved paths both sides changed relative to HEAD — unless the
 * remote already holds exactly the bytes being approved (or both deleted it).
 * `approved` maps each path to its approved content (null = deleted).
 */
function findConflicts(
  snapshot: Map<string, Buffer>,
  approved: Map<string, Buffer | null>,
  remote: Map<string, "modified" | "added" | "deleted">,
): RemoteConflict[] {
  const conflicts: RemoteConflict[] = [];
  for (const [path, localContent] of approved) {
    const kind = remote.get(path);
    if (!kind) continue;
    const remoteContent = snapshot.get(path);
    if (remoteContent && localContent && remoteContent.equals(localContent)) continue;
    if (!remoteContent && !localContent) continue;
    conflicts.push({ path, kind: kind === "deleted" ? "deleted-remote" : localContent ? "modified" : "deleted-local" });
  }
  return conflicts;
}

/** An approved file whose Overleaf changes merge cleanly with it. */
interface PlannedMerge {
  path: string;
  /** Overleaf's version: HEAD takes it first. */
  remote: Buffer;
  /** The approved content merged onto Overleaf's version: what gets pushed. */
  staged: Buffer;
  /** Every pending edit of the file merged onto Overleaf's version. */
  worktree: Buffer;
  /** The worktree before, for the rollback. */
  original: Buffer;
}

/**
 * Line-merge one conflicting approved file: base = HEAD, yours = the
 * approved content, Overleaf = the snapshot. After a partial approval the
 * rest of the file's pending edits must merge too, or they would end up
 * pending against a base they no longer fit. Otherwise it is a conflict,
 * described from the worktree (what the user sees and would resolve).
 */
async function planMerge(
  dir: string,
  path: string,
  approved: Buffer | null,
  remote: Buffer | null,
): Promise<PlannedMerge | { conflict: RemoteConflict }> {
  const base = await git.readBlob(dir, "HEAD", path);
  const original = readWorktree(dir, path);
  const refuse = async () => ({ conflict: await describeConflict(path, base, original ?? approved, remote) });
  if (!base || !approved || !remote || !original) return refuse();
  const staged = await mergeText(base, approved, remote, CONFLICT_LABELS);
  if (!staged || staged.conflicts > 0) return refuse();
  let worktree = staged.content;
  if (!original.equals(approved)) {
    const rest = await mergeText(base, original, remote, CONFLICT_LABELS);
    if (!rest || rest.conflicts > 0) return refuse();
    worktree = rest.content;
  }
  return { path, remote, staged: staged.content, worktree, original };
}

/** Paths a unified patch touches (both sides of its `diff --git` headers). */
function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.*) b\/(.*)$/gm)) {
    paths.add(m[1]);
    paths.add(m[2]);
  }
  return [...paths];
}

/**
 * Put exactly what is being approved into the index: everything for a full
 * approval, otherwise the selected files and hunks on top of HEAD. Returns
 * the staged paths. A hunk must still be in the worktree (so nothing the
 * user is no longer looking at gets pushed) and apply cleanly to HEAD.
 */
async function stageApproval(dir: string, selection?: ApproveSelection): Promise<string[]> {
  if (!selection) {
    await git.stageAll(dir);
    return git.stagedPaths(dir);
  }
  const pending = new Set(await git.changedPaths(dir));
  const stale = (path: string) =>
    new SelectionError(`${path} has no pending changes any more — refresh the proof`);
  await git.resetIndex(dir);
  try {
    const files = selection.files ?? [];
    for (const path of files) if (!pending.has(path)) throw stale(path);
    await git.stagePaths(dir, files);
    for (const patch of selection.patches ?? []) {
      const paths = patchPaths(patch);
      if (paths.length === 0) throw new SelectionError("not a git patch");
      for (const path of paths) if (!pending.has(path)) throw stale(path);
      try {
        await git.applyPatch(dir, patch, ["--reverse", "--check"]);
        await git.applyPatch(dir, patch, ["--cached"]);
      } catch {
        throw new SelectionError("That change no longer matches the file — refresh the proof");
      }
    }
    const staged = await git.stagedPaths(dir);
    if (staged.length === 0) throw new SelectionError("Nothing to approve in that selection — refresh the proof");
    return staged;
  } catch (err) {
    await git.resetIndex(dir);
    throw err;
  }
}

/**
 * Commit the reviewed changes and propagate them to the remote — all pending
 * changes, or only `opts.selection` (the rest stays pending in the worktree).
 */
export async function approve(
  project: Project,
  message: string,
  opts: ApproveOptions = {},
): Promise<ApproveResult> {
  const dir = projectDir(project.id);
  // Everything still pending before this approval (for the absorb rule).
  const local = await git.changedPaths(dir);
  const approvedPaths = await stageApproval(dir, opts.selection);
  if (project.kind === "local") {
    // No remote — approval is just the local commit.
    await git.commitStagedExcept(dir, message, []);
    return { pushed: false };
  }
  // A sync conflict (Git autostash, or "Resolve in editor" on Overleaf)
  // leaves <<<<<<< markers in the files; committing them would push them as
  // content. Judged on what is staged.
  const conflicted: string[] = [];
  for (const path of approvedPaths) {
    if (hasConflictMarkers(await git.readBlob(dir, null, path))) conflicted.push(path);
  }
  if (conflicted.length > 0) {
    await git.resetIndex(dir);
    throw new Error(
      project.kind === "overleaf"
        ? `Resolve the conflicts in ${conflicted.join(", ")} first — they still contain <<<<<<< conflict markers.`
        : `Resolve the Git conflicts in ${conflicted.join(", ")} first — they still contain <<<<<<< conflict markers.`,
    );
  }
  if (project.kind === "overleaf") {
    // Drift check: a collaborator may have edited on Overleaf since our last
    // sync — never silently clobber those edits with a whole-file upload.
    // Edits to different lines are merged; only overlaps need the user.
    let snapshot: Map<string, Buffer>;
    let remote: Map<string, "modified" | "added" | "deleted">;
    const forced: RemoteConflict[] = [];
    const merges: PlannedMerge[] = [];
    try {
      const zip = await withSession(project, (client) => client.downloadZip(project.overleafProjectId!));
      snapshot = unpackZip(zip);
      remote = await scanRemoteDrift(dir, snapshot);
      const approved = new Map<string, Buffer | null>();
      for (const path of approvedPaths) approved.set(path, await git.readBlob(dir, null, path));
      const forcePaths = new Set(opts.forcePaths ?? []);
      const refused: RemoteConflict[] = [];
      for (const c of findConflicts(snapshot, approved, remote)) {
        if (opts.force || forcePaths.has(c.path)) {
          forced.push(c);
          continue;
        }
        const plan = await planMerge(dir, c.path, approved.get(c.path) ?? null, snapshot.get(c.path) ?? null);
        if ("conflict" in plan) refused.push(plan.conflict);
        else merges.push(plan);
      }
      if (refused.length > 0) throw new ApproveConflictError(refused);
    } catch (err) {
      await git.resetIndex(dir);
      throw err;
    }
    const warnings: string[] = [];
    if (forced.length > 0) {
      // Forced: keep the remote's versions recoverable before overwriting them.
      // Living under .git keeps the backups out of the worktree and the diff.
      const stamp = new Date().toISOString().replace(/:/g, "-");
      const backupDir = join(dir, ".git", "blattbot", "remote-backup", stamp);
      for (const c of forced) {
        const content = snapshot.get(c.path);
        if (!content) continue; // deleted remotely — nothing to back up
        mkdirSync(dirname(join(backupDir, c.path)), { recursive: true });
        writeFileSync(join(backupDir, c.path), content);
      }
      const names = forced.map((c) => c.path).join(", ");
      warnings.push(`Overleaf's version${forced.length === 1 ? "" : "s"} of ${names} ${forced.length === 1 ? "was" : "were"} backed up to ${backupDir}`);
    }
    if (merges.length > 0) {
      // HEAD first takes Overleaf's version of these files (a sync commit of
      // only them), the approval is re-staged merged onto it, and the
      // worktree keeps every pending edit on top. The push then carries the
      // co-author's edits and the approved ones; the rest stays pending.
      const before = await git.revParse(dir, "HEAD");
      try {
        await git.commitContents(dir, "Sync from Overleaf", new Map(merges.map((m) => [m.path, m.remote])));
        await git.setIndexContents(dir, new Map(merges.map((m) => [m.path, m.staged])));
        for (const m of merges) writeFileSync(join(dir, m.path), m.worktree);
      } catch (err) {
        await git.resetSoft(dir, before).catch(() => {});
        await git.resetIndex(dir).catch(() => {});
        for (const m of merges) {
          try {
            writeFileSync(join(dir, m.path), m.original);
          } catch {
            /* best effort */
          }
        }
        throw err;
      }
    }
    // After the push, Overleaf's other changes come in the way a sync brings
    // them: untouched paths take Overleaf's version, unapproved pending ones
    // are merged line by line (overlaps stay drift). The snapshot predates
    // our push, so only paths outside the approval may come from it —
    // applying it whole would revert what was just pushed. NEVER fatal: it
    // runs after the commit (and push), which have already landed, so a
    // failure degrades to a warning instead of failing the approve.
    const localSet = new Set([...local, ...approvedPaths]);
    const approvedSet = new Set(approvedPaths);
    const absorbed = [...remote.keys()].filter((p) => !localSet.has(p));
    const leftover = [...remote.keys()].filter((p) => localSet.has(p) && !approvedSet.has(p));
    let after: RemoteMergeResult | null = null;
    const absorb = async (): Promise<string | null> => {
      const paths = [...absorbed, ...leftover];
      if (paths.length === 0) return null;
      try {
        after = await mergeRemoteChanges(dir, snapshot, paths, new Set(local));
        return null;
      } catch (err: any) {
        return `could not pick up Overleaf's changes to ${paths.join(", ")} (${err?.message ?? err}) — run Sync to retry`;
      }
    };
    /** What the approve merged and left behind, for the result. */
    const remoteOutcome = () => {
      const done = after as RemoteMergeResult | null;
      const mergedRemote = [...merges.map((m) => m.path), ...(done?.rebased ?? [])];
      return {
        ...(absorbed.length > 0 ? { absorbedRemote: absorbed } : {}),
        ...(mergedRemote.length > 0 ? { mergedRemote } : {}),
        ...(done?.drift.length ? { drift: done.drift, conflicts: done.conflicts } : {}),
      };
    };
    const base = await git.revParse(dir, "HEAD");
    const committed = await git.commitStagedExcept(dir, message, []);
    if (!committed) {
      const absorbWarn = await absorb();
      const allWarnings = [...warnings, ...(absorbWarn ? [absorbWarn] : [])];
      return {
        pushed: false,
        ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        ...remoteOutcome(),
      };
    }
    const head = await git.revParse(dir, "HEAD");
    // Whatever did not reach Overleaf must not stay committed: the next sync
    // would see a clean tree and write Overleaf's versions over those edits.
    // Un-committing keeps them pending; approving again re-pushes them (paths
    // that did land already match the remote and pass the conflict check).
    let result: PushResult;
    try {
      result = await withSession(project, (client) =>
        pushChanges(client, project.overleafProjectId!, dir, base, head, snapshot),
      );
    } catch (err: any) {
      await git.resetSoft(dir, base);
      throw new Error(`Push to Overleaf failed (${err?.message ?? err}) — your changes are still pending; approve again to retry`, { cause: err });
    }
    const { failed, ...pushed } = result;
    if (failed.length > 0) {
      await git.resetSoft(dir, base);
      await git.commitStagedExcept(dir, message, failed);
    }
    const absorbWarn = await absorb();
    // Our own push must not read as a co-author's change: re-read Overleaf's
    // lastUpdated now. (The next quick sync still downloads in full: HEAD
    // moved, so the recorded tree no longer matches.)
    let remoteLastUpdated: string | undefined;
    try {
      remoteLastUpdated = await withSession(project, (client) => listedLastUpdated(client, project.overleafProjectId!));
    } catch {
      /* keep the old value: the UI then offers a sync it did not need */
    }
    if (remoteLastUpdated) recordRemote(project, { remoteLastUpdated });
    return {
      pushed: true,
      ...pushed,
      warnings: [...warnings, ...result.warnings, ...(absorbWarn ? [absorbWarn] : [])],
      ...remoteOutcome(),
      ...(failed.length > 0 ? { pending: failed } : {}),
      ...(remoteLastUpdated ? { remoteLastUpdated } : {}),
    };
  }
  await moveRemoteCredentials(project);
  if (!(await git.commitStagedExcept(dir, message, []))) return { pushed: false };
  return git.pushHead(dir, project.token);
}

export interface ResolvedConflict {
  path: string;
  /** Conflict blocks written into the file ("markers" only; 0 = it merged cleanly). */
  conflicts: number;
  /** First line of the first conflict block. */
  line?: number;
}

/**
 * Settle files that Overleaf and the local tree both changed, per file:
 *  - "overleaf": take Overleaf's version — HEAD and worktree — dropping the
 *    local edits to that file only;
 *  - "markers": HEAD takes Overleaf's version, the worktree the line merge
 *    with conflict markers (yours / Overleaf) where the edits overlap, to
 *    edit by hand. Approve refuses the file while the markers remain.
 * Other files' pending edits are not touched.
 */
export async function resolveConflicts(
  project: Project,
  paths: string[],
  keep: "overleaf" | "markers",
): Promise<ResolvedConflict[]> {
  if (project.kind !== "overleaf") throw new Error("only Overleaf projects can take Overleaf's version of a file");
  const dir = projectDir(project.id);
  const snapshot = unpackZip(await withSession(project, (client) => client.downloadZip(project.overleafProjectId!)));
  if (keep === "overleaf") {
    await applyRemoteVersions(dir, snapshot, paths, new Map());
    return paths.map((path) => ({ path, conflicts: 0 }));
  }
  const rebased = new Map<string, RebasedFile>();
  const resolved: ResolvedConflict[] = [];
  for (const path of paths) {
    const mine = readWorktree(dir, path);
    const remote = snapshot.get(path) ?? null;
    const base = (await git.readBlob(dir, "HEAD", path)) ?? Buffer.alloc(0);
    const merged = mine && remote ? await mergeText(base, mine, remote, CONFLICT_LABELS) : null;
    if (!merged) {
      throw new Error(
        `${path} cannot be merged line by line (${!mine || !remote ? "deleted on one side" : "not a text file"}) — keep Overleaf's version or overwrite it instead`,
      );
    }
    rebased.set(path, { content: merged.content, original: mine! });
    const lines = merged.content.toString("utf8").split("\n");
    const first = lines.findIndex((l) => /^<{7}(?: |$)/.test(l));
    resolved.push({ path, conflicts: merged.conflicts, ...(first >= 0 ? { line: first + 1 } : {}) });
  }
  await applyRemoteVersions(dir, snapshot, [], rebased);
  return resolved;
}

/**
 * Git-bridge clones made by older versions keep the token in .git/config's
 * remote URL, readable from an agent's shell. Move it to the project record
 * (projects.json, which agents cannot read) and strip it from the URL.
 */
export async function moveRemoteCredentials(project: Project): Promise<void> {
  if ((project.kind ?? "git") !== "git") return;
  const token = await git.stripRemoteCredentials(projectDir(project.id));
  if (token && !project.token) {
    updateProject(project.id, { token });
    project.token = token;
  }
}

/**
 * "Verify on Overleaf": run the remote instance's own compiler on the
 * project's CURRENT REMOTE state (what has been approved & pushed — never
 * unpushed local edits) and return its PDF or log tail.
 */
export async function remoteCompile(project: Project): Promise<RemoteCompileResult> {
  if (project.kind !== "overleaf") {
    throw new Error("remote compile is only available for Overleaf cookie-mode projects");
  }
  return withSession(project, (client) => client.compileProject(project.overleafProjectId!));
}

export interface PublishTreeResult extends PushResult {
  remoteProjectId: string;
}

/**
 * Create a fresh Overleaf project named `name`, wipe its template entities,
 * and upload every file under `dir`. Pure client flow — no registry access —
 * so it is testable against the mock instance on its own.
 */
export async function publishTree(
  client: OverleafClient,
  name: string,
  dir: string,
): Promise<PublishTreeResult> {
  const remoteProjectId = await client.createProject(name);
  // Fresh projects come with template docs/files ("example" template) —
  // delete the entities (not the folders) so our tree replaces them cleanly.
  const tree = await client.joinProjectTree(remoteProjectId);
  for (const entity of tree.entities.values()) {
    await client.deleteEntity(remoteProjectId, entity.type, entity.id);
  }
  const result = await pushAll(client, remoteProjectId, dir);
  return { remoteProjectId, ...result };
}

export interface PublishResult extends PushResult {
  project: Project;
}

/**
 * Publish a kind "local" project to an Overleaf account. On success the
 * registry entry becomes kind "overleaf" and normal cookie-sync applies.
 */
export async function publishLocal(project: Project, account: OlAccount): Promise<PublishResult> {
  if (project.kind !== "local") throw new Error("only local projects can be published");
  const dir = projectDir(project.id);
  // Commit any pending edits so the published state matches a commit.
  await git.commitAll(dir, "Publish to Overleaf");
  const client = new OverleafClient(account.baseUrl, account.cookie);
  const { remoteProjectId, ...result } = await publishTree(client, project.name, dir);
  const updated = updateProject(project.id, {
    kind: "overleaf",
    accountId: account.id,
    overleafBaseUrl: account.baseUrl,
    overleafProjectId: remoteProjectId,
    gitUrl: `${account.baseUrl}/project/${remoteProjectId}`,
  })!;
  return { project: updated, ...result };
}
