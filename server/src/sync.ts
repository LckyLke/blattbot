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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir, updateProject, type Project } from "./config.js";
import * as git from "./git.js";
import { OverleafAuthError, OverleafClient, type RemoteCompileResult } from "./overleaf/olclient.js";
import {
  mergeRemotePaths,
  pushAll,
  pushChanges,
  scanRemoteDrift,
  syncIn as olSyncIn,
  unpackZip,
  type PushResult,
} from "./overleaf/olsync.js";
import { cookieForProject, getAccount, refreshFromBrowsers, updateAccount, type OlAccount } from "./accounts.js";

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
  /** Remote-changed paths merged in while local edits were pending. */
  merged?: string[];
  /** Remote-changed paths left alone because they also have local edits. */
  drift?: string[];
}

/** Bring the working tree up to date with the remote before an agent turn. */
export async function syncIn(project: Project): Promise<SyncResult> {
  const dir = projectDir(project.id);
  if (project.kind === "local") return { ok: true };
  if (project.kind === "overleaf") {
    const result = await withSession(project, (client) =>
      olSyncIn(client, project.overleafProjectId!, dir),
    );
    const parts: string[] = [];
    if (result.merged?.length) parts.push(`merged remote changes to: ${result.merged.join(", ")}`);
    else if (result.changed) parts.push("picked up remote changes");
    if (result.drift?.length) {
      parts.push(
        `Overleaf has newer versions of: ${result.drift.join(", ")} — they'll be merged once your local edits to them are resolved`,
      );
    }
    return {
      ok: true,
      detail: parts.length > 0 ? parts.join("; ") : undefined,
      changed: result.changed,
      merged: result.merged,
      drift: result.drift,
    };
  }
  await moveRemoteCredentials(project);
  const before = await git.revParse(dir, "HEAD");
  await git.pull(dir, project.token);
  const drift = await git.unmergedPaths(dir);
  return {
    ok: true,
    changed: before !== await git.revParse(dir, "HEAD"),
    drift,
    ...(drift.length ? { detail: `Git conflicts need resolving in: ${drift.join(", ")}. Your original local edits are also preserved in the Git stash.` } : {}),
  };
}

export interface RemoteConflict {
  path: string;
  kind: "modified" | "deleted-remote";
}

/** Approval refused: the remote changed files that also have local edits. */
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
  deleted?: string[];
  warnings?: string[];
  /** Remote-only changes absorbed into the mirror after the push. */
  absorbedRemote?: string[];
  /** Approved paths that did not reach the remote; they stay pending. */
  pending?: string[];
}

export interface ApproveOptions {
  /** Overwrite conflicting remote edits (their versions are backed up first). */
  force?: boolean;
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
    conflicts.push({ path, kind: kind === "deleted" ? "deleted-remote" : "modified" });
  }
  return conflicts;
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
  if (project.kind === "overleaf") {
    // Drift check: a collaborator may have edited on Overleaf since our last
    // sync — never silently clobber those edits with a whole-file upload.
    let snapshot: Map<string, Buffer>;
    let remote: Map<string, "modified" | "added" | "deleted">;
    let conflicts: RemoteConflict[];
    try {
      const zip = await withSession(project, (client) => client.downloadZip(project.overleafProjectId!));
      snapshot = unpackZip(zip);
      remote = await scanRemoteDrift(dir, snapshot);
      const approved = new Map<string, Buffer | null>();
      for (const path of approvedPaths) approved.set(path, await git.readBlob(dir, null, path));
      conflicts = findConflicts(snapshot, approved, remote);
      if (conflicts.length > 0 && !opts.force) throw new ApproveConflictError(conflicts);
    } catch (err) {
      await git.resetIndex(dir);
      throw err;
    }
    const warnings: string[] = [];
    if (conflicts.length > 0) {
      // Forced: keep the remote's versions recoverable before overwriting them.
      // Living under .git keeps the backups out of the worktree and the diff.
      const stamp = new Date().toISOString().replace(/:/g, "-");
      const backupDir = join(dir, ".git", "blattbot", "remote-backup", stamp);
      for (const c of conflicts) {
        const content = snapshot.get(c.path);
        if (!content) continue; // deleted remotely — nothing to back up
        mkdirSync(dirname(join(backupDir, c.path)), { recursive: true });
        writeFileSync(join(backupDir, c.path), content);
      }
      warnings.push(`Overleaf's versions of the overwritten files were backed up to ${backupDir}`);
    }
    // Remote changes to paths with NO pending local edits are absorbed after
    // the push — not just unapproved ones: a pending path stays drift.
    const localSet = new Set([...local, ...approvedPaths]);
    const absorbed = [...remote.keys()].filter((p) => !localSet.has(p));
    // Reconcile: the remote-only changes become a normal sync commit. The
    // snapshot predates our push, so only those untouched paths may come
    // from it — applying it whole would revert what was just pushed. NEVER
    // fatal: it runs after the commit (and push), which have already landed,
    // so a failure here degrades to a warning instead of failing the approve.
    const absorb = async (): Promise<string | null> => {
      if (absorbed.length === 0) return null;
      try {
        await mergeRemotePaths(dir, snapshot, absorbed);
        return null;
      } catch (err: any) {
        return `could not pick up Overleaf's changes to ${absorbed.join(", ")} (${err?.message ?? err}) — run Sync to retry`;
      }
    };
    const base = await git.revParse(dir, "HEAD");
    const committed = await git.commitStagedExcept(dir, message, []);
    if (!committed) {
      const absorbWarn = await absorb();
      const allWarnings = [...warnings, ...(absorbWarn ? [absorbWarn] : [])];
      return {
        pushed: false,
        ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        ...(absorbed.length > 0 ? { absorbedRemote: absorbed } : {}),
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
    return {
      pushed: true,
      ...pushed,
      warnings: [...warnings, ...result.warnings, ...(absorbWarn ? [absorbWarn] : [])],
      ...(absorbed.length > 0 ? { absorbedRemote: absorbed } : {}),
      ...(failed.length > 0 ? { pending: failed } : {}),
    };
  }
  // An autostash conflict from a sync leaves <<<<<<< markers in the files;
  // committing them would push them as content. Judged on what is staged.
  const conflicted: string[] = [];
  for (const path of approvedPaths) {
    const content = (await git.readBlob(dir, null, path))?.toString("utf8") ?? "";
    if (/^<{7}(?: |$)/m.test(content) && /^>{7}(?: |$)/m.test(content)) conflicted.push(path);
  }
  if (conflicted.length > 0) {
    await git.resetIndex(dir);
    throw new Error(`Resolve the Git conflicts in ${conflicted.join(", ")} first — they still contain <<<<<<< conflict markers.`);
  }
  await moveRemoteCredentials(project);
  if (!(await git.commitStagedExcept(dir, message, []))) return { pushed: false };
  return git.pushHead(dir, project.token);
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
