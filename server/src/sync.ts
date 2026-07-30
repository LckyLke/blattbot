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
import { projectDir, updateProject, type Project } from "./config.js";
import * as git from "./git.js";
import { OverleafAuthError, OverleafClient } from "./overleaf/olclient.js";
import { pushAll, pushChanges, syncIn as olSyncIn, type PushResult } from "./overleaf/olsync.js";
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
}

/** Bring the working tree up to date with the remote before an agent turn. */
export async function syncIn(project: Project): Promise<SyncResult> {
  const dir = projectDir(project.id);
  if (project.kind === "local") return { ok: true };
  if (project.kind === "overleaf") {
    const result = await withSession(project, (client) =>
      olSyncIn(client, project.overleafProjectId!, dir),
    );
    if (result.skipped === "dirty") {
      return { ok: true, detail: "working tree has pending changes — skipped refresh from Overleaf" };
    }
    return { ok: true, detail: result.changed ? "picked up remote changes" : undefined };
  }
  await git.pull(dir);
  return { ok: true };
}

export interface ApproveResult {
  pushed: boolean;
  uploaded?: string[];
  deleted?: string[];
  warnings?: string[];
}

/** Commit the reviewed changes and propagate them to the remote. */
export async function approve(project: Project, message: string): Promise<ApproveResult> {
  const dir = projectDir(project.id);
  if (project.kind === "local") {
    // No remote — approval is just the local commit.
    await git.commitAll(dir, message);
    return { pushed: false };
  }
  if (project.kind === "overleaf") {
    const base = await git.revParse(dir, "HEAD");
    const committed = await git.commitAll(dir, message);
    if (!committed) return { pushed: false };
    const head = await git.revParse(dir, "HEAD");
    const result = await withSession(project, (client) =>
      pushChanges(client, project.overleafProjectId!, dir, base, head),
    );
    return { pushed: true, ...result };
  }
  return git.commitAndPush(dir, message);
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
