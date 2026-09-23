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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  await git.pull(dir);
  return { ok: true };
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
}

export interface ApproveOptions {
  /** Overwrite conflicting remote edits (their versions are backed up first). */
  force?: boolean;
}

/**
 * Conflicts = paths both sides changed relative to HEAD — unless the remote
 * already holds exactly the local bytes (or both sides deleted the path).
 */
function findConflicts(
  dir: string,
  snapshot: Map<string, Buffer>,
  localPaths: string[],
  remote: Map<string, "modified" | "added" | "deleted">,
): RemoteConflict[] {
  const conflicts: RemoteConflict[] = [];
  for (const path of localPaths) {
    const kind = remote.get(path);
    if (!kind) continue;
    const remoteContent = snapshot.get(path);
    let localContent: Buffer | null = null;
    try {
      localContent = readFileSync(join(dir, path));
    } catch {
      /* locally deleted */
    }
    if (remoteContent && localContent && remoteContent.equals(localContent)) continue;
    if (!remoteContent && !localContent) continue;
    conflicts.push({ path, kind: kind === "deleted" ? "deleted-remote" : "modified" });
  }
  return conflicts;
}

/** Commit the reviewed changes and propagate them to the remote. */
export async function approve(
  project: Project,
  message: string,
  opts: ApproveOptions = {},
): Promise<ApproveResult> {
  const dir = projectDir(project.id);
  if (project.kind === "local") {
    // No remote — approval is just the local commit.
    await git.commitAll(dir, message);
    return { pushed: false };
  }
  if (project.kind === "overleaf") {
    // Drift check: a collaborator may have edited on Overleaf since our last
    // sync — never silently clobber those edits with a whole-file upload.
    const zip = await withSession(project, (client) => client.downloadZip(project.overleafProjectId!));
    const snapshot = unpackZip(zip);
    const local = await git.changedPaths(dir);
    const remote = await scanRemoteDrift(dir, snapshot);
    const conflicts = findConflicts(dir, snapshot, local, remote);
    if (conflicts.length > 0 && !opts.force) throw new ApproveConflictError(conflicts);
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
    // Remote changes to paths we did NOT touch are absorbed after the push.
    const localSet = new Set(local);
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
    const committed = await git.commitAll(dir, message);
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
    const result = await withSession(project, (client) =>
      pushChanges(client, project.overleafProjectId!, dir, base, head),
    );
    const absorbWarn = await absorb();
    return {
      pushed: true,
      ...result,
      warnings: [...warnings, ...result.warnings, ...(absorbWarn ? [absorbWarn] : [])],
      ...(absorbed.length > 0 ? { absorbedRemote: absorbed } : {}),
    };
  }
  return git.commitAndPush(dir, message);
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
