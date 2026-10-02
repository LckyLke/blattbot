/**
 * Sync between an Overleaf project (cookie mode) and the local git mirror.
 * The local repo is the review surface: every server state becomes a commit,
 * agent edits stay uncommitted until approved, and approval both commits
 * locally and replays the change set onto the Overleaf project.
 */
import { unzipSync } from "fflate";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listFiles } from "../latex.js";
import * as git from "../git.js";
import { OverleafClient, type OlRealtimeSession, type ProjectTree } from "./olclient.js";
import { computeTextOp } from "./ot.js";

export interface SyncInResult {
  changed: boolean;
  /** Remote-changed paths merged into the tree while local edits were pending. */
  merged?: string[];
  /** Remote-changed paths left untouched because they also have local edits. */
  drift?: string[];
}

/** Unpack a project zip buffer into { relPath → content }. Directory entries are dropped. */
export function unpackZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const files = unzipSync(new Uint8Array(zip));
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith("/")) continue;
    const clean = path.replace(/^\/+/, "");
    if (!clean || clean.includes("..")) continue;
    out.set(clean, Buffer.from(data));
  }
  return out;
}

/**
 * Overwrite the working tree with the given snapshot (deleting local files
 * that disappeared server-side) and commit the result as a sync commit.
 * Only call with a clean working tree.
 */
export async function applySnapshot(dir: string, snapshot: Map<string, Buffer>, message: string): Promise<boolean> {
  const existing = listFiles(dir);
  for (const rel of existing) {
    if (!snapshot.has(rel)) rmSync(join(dir, rel), { force: true });
  }
  for (const [rel, content] of snapshot) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    const target = join(dir, rel);
    try {
      const current = readFileSync(target);
      if (current.equals(content)) continue;
    } catch {
      /* new file */
    }
    writeFileSync(target, content);
  }
  return git.commitAll(dir, message);
}

export type RemoteChangeKind = "modified" | "added" | "deleted";

/** True when the worktree holds exactly `remote` at `rel` (both absent counts too). */
function sameAsWorktree(dir: string, rel: string, remote: Buffer | undefined): boolean {
  let local: Buffer | undefined;
  try {
    local = readFileSync(join(dir, rel));
  } catch {
    /* absent locally */
  }
  return local && remote ? local.equals(remote) : !local && !remote;
}

/** Which remote snapshot paths differ from HEAD, and how. */
export async function scanRemoteDrift(
  dir: string,
  snapshot: Map<string, Buffer>,
): Promise<Map<string, RemoteChangeKind>> {
  const drift = new Map<string, RemoteChangeKind>();
  const head = await git.headBlobs(dir);
  for (const [rel, content] of snapshot) {
    const committed = head.get(rel);
    if (!committed) drift.set(rel, "added");
    else if (committed !== git.blobId(content, committed)) drift.set(rel, "modified");
  }
  for (const rel of head.keys()) {
    if (!snapshot.has(rel)) drift.set(rel, "deleted");
  }
  return drift;
}

/**
 * Write the remote's version of the given paths into the worktree (deleting
 * paths the remote no longer has) and commit ONLY those paths — pending
 * changes to any other path stay uncommitted.
 */
export async function mergeRemotePaths(
  dir: string,
  snapshot: Map<string, Buffer>,
  paths: string[],
  message = "Sync from Overleaf",
): Promise<boolean> {
  for (const rel of paths) {
    const target = join(dir, rel);
    const content = snapshot.get(rel);
    if (content === undefined) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return git.commitPaths(dir, message, paths);
}

/**
 * Pull the latest server state into the local mirror. With a clean tree the
 * whole snapshot lands as one sync commit; with pending local edits only the
 * remote changes to untouched paths are merged in (committed selectively) and
 * the overlapping paths are reported as drift, their local content untouched.
 */
export async function syncIn(
  client: OverleafClient,
  remoteProjectId: string,
  dir: string,
  prefetched?: Map<string, Buffer>,
): Promise<SyncInResult> {
  const dirty = await git.hasChanges(dir);
  const snapshot = prefetched ?? unpackZip(await client.downloadZip(remoteProjectId));
  if (!dirty) {
    const changed = await applySnapshot(dir, snapshot, "Sync from Overleaf");
    return { changed };
  }
  const local = new Set(await git.changedPaths(dir));
  const remote = await scanRemoteDrift(dir, snapshot);
  const merged: string[] = [];
  const drift: string[] = [];
  for (const rel of remote.keys()) {
    if (!local.has(rel)) {
      merged.push(rel);
      continue;
    }
    // Already identical on both sides (e.g. pushed before a failed approve
    // was rolled back) — pending locally, but not drift.
    if (sameAsWorktree(dir, rel, snapshot.get(rel))) continue;
    drift.push(rel);
  }
  const changed = merged.length > 0 ? await mergeRemotePaths(dir, snapshot, merged) : false;
  return {
    changed,
    ...(merged.length > 0 ? { merged } : {}),
    ...(drift.length > 0 ? { drift } : {}),
  };
}

export interface PushChange {
  status: "upload" | "delete";
  path: string;
}

/** Turn `git diff --name-status` output into an ordered push plan. */
export function parseNameStatus(nameStatus: string): PushChange[] {
  const changes: PushChange[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (status.startsWith("R") || status.startsWith("C")) {
      // rename/copy: old path deleted (rename only), new path uploaded
      if (status.startsWith("R")) changes.push({ status: "delete", path: parts[1] });
      changes.push({ status: "upload", path: parts[2] });
    } else if (status === "D") {
      changes.push({ status: "delete", path: parts[1] });
    } else {
      changes.push({ status: "upload", path: parts[1] });
    }
  }
  return changes;
}

export interface PushResult {
  /** Every path that landed remotely (upload or in-place edit). */
  uploaded: string[];
  /** Subset of uploaded that was edited in place — entity ids preserved. */
  updatedInPlace: string[];
  deleted: string[];
  /** Paths that did NOT reach Overleaf (each also carries a warning). */
  failed: string[];
  warnings: string[];
}

/**
 * Replay a committed change set (fromRef → toRef) onto the Overleaf project.
 * Existing text docs are edited in place over the realtime channel (entity
 * ids survive); everything else uploads, replacing existing entities
 * (delete-then-upload when the server rejects duplicates). Deletions resolve
 * entity ids via the realtime tree.
 */
export async function pushChanges(
  client: OverleafClient,
  remoteProjectId: string,
  dir: string,
  fromRef: string,
  toRef: string,
  /** The remote state the caller's conflict check approved (see applyChanges). */
  checkedSnapshot?: Map<string, Buffer>,
): Promise<PushResult> {
  const nameStatus = await git.diffNameStatus(dir, fromRef, toRef);
  // Content comes from the commit, not the worktree: after a partial approval
  // the worktree still holds edits that were not approved.
  const read = async (path: string) => {
    const content = await git.readBlob(dir, toRef, path);
    if (!content) throw new Error(`${path} is missing from the approved commit`);
    return content;
  };
  return applyChanges(client, remoteProjectId, read, parseNameStatus(nameStatus), checkedSnapshot);
}

/** Upload the entire working tree (used when publishing a local project). */
export async function pushAll(
  client: OverleafClient,
  remoteProjectId: string,
  dir: string,
): Promise<PushResult> {
  const changes: PushChange[] = listFiles(dir).map((path) => ({ status: "upload", path }));
  return applyChanges(client, remoteProjectId, async (path) => readFileSync(join(dir, path)), changes);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A co-author changed the doc after the conflict check — never overwrite that. */
class RemoteDocChangedError extends Error {}

/** Same doc text, ignoring line-ending and final-newline differences. */
function sameDocText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return a === b || norm(a) === norm(b);
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
function decodeUtf8(buf: Buffer): string | null {
  try {
    return strictUtf8.decode(buf);
  } catch {
    return null;
  }
}

/**
 * With `checkedSnapshot`, an in-place doc edit first confirms the live doc
 * still matches the snapshot the caller's conflict check approved. The edit
 * is computed against the LIVE text, so anything a co-author typed after the
 * snapshot would otherwise be silently reverted; such a doc is left alone and
 * reported as failed (it stays pending, and the next approve's conflict check
 * shows the overlap).
 */
async function applyChanges(
  client: OverleafClient,
  remoteProjectId: string,
  read: (path: string) => Promise<Buffer>,
  changes: PushChange[],
  checkedSnapshot?: Map<string, Buffer>,
): Promise<PushResult> {
  const result: PushResult = { uploaded: [], updatedInPlace: [], deleted: [], failed: [], warnings: [] };
  if (changes.length === 0) return result;

  let tree: ProjectTree | null = null;
  const getTree = async (): Promise<ProjectTree | null> => {
    if (tree) return tree;
    try {
      tree = await client.joinProjectTree(remoteProjectId);
      return tree;
    } catch (err: any) {
      result.warnings.push(`could not fetch the project file tree (${err?.message ?? err})`);
      return null;
    }
  };

  /**
   * Resolve (creating if needed) the folder id a file's directory maps to.
   * Older CE builds require an explicit folder_id on upload and don't create
   * intermediate folders from relativePath.
   */
  const ensureFolderId = async (fileDir: string): Promise<string | undefined> => {
    const t = await getTree();
    if (!t) return undefined;
    if (!fileDir) return t.rootFolderId;
    const known = t.folders.get(fileDir);
    if (known) return known;
    let path = "";
    let parentId = t.rootFolderId;
    for (const seg of fileDir.split("/")) {
      path = path ? `${path}/${seg}` : seg;
      let id = t.folders.get(path);
      if (!id) {
        id = await client.createFolder(remoteProjectId, seg, parentId);
        t.folders.set(path, id);
      }
      parentId = id;
    }
    return parentId;
  };

  // Realtime session for in-place doc edits: opened lazily on the first doc
  // that needs it, reused across all docs in this push, closed at the end.
  let session: OlRealtimeSession | null = null;
  const getSession = async (): Promise<OlRealtimeSession> => {
    if (session && !session.alive) session = null;
    if (!session) session = await client.connectRealtime(remoteProjectId);
    return session;
  };
  const closeSession = (): void => {
    session?.close();
  };

  /**
   * Edit an existing doc in place (joinDoc → applyOtUpdate → leaveDoc) so its
   * entity id — and with it review comments, tracked changes, and per-doc
   * history — survives. One retry on a version conflict (someone else's op
   * landed between our join and our update); any other failure propagates to
   * the caller, which falls back to the upload path.
   *
   * The applyOtUpdate ack only confirms the op was ENQUEUED (real Overleaf
   * applies it asynchronously and reports failures as a later otUpdateError),
   * so the edit is verified by re-joining the doc and byte-comparing its text
   * against the target — a mismatch or a pushed otUpdateError fails the doc.
   */
  const updateDocInPlace = async (docId: string, target: string, path: string): Promise<void> => {
    const s = await getSession();
    const { lines, version } = await s.joinDoc(docId);
    const checked = checkedSnapshot ? decodeUtf8(checkedSnapshot.get(path) ?? Buffer.alloc(0)) : null;
    const assertUnchanged = (live: string) => {
      if (checkedSnapshot && !checkedSnapshot.has(path)) throw new RemoteDocChangedError();
      if (checked !== null && !sameDocText(live, checked)) throw new RemoteDocChangedError();
    };
    try {
      const current = lines.join("\n");
      if (current === target) return; // remote already matches
      assertUnchanged(current);
      try {
        await s.applyOtUpdate(docId, computeTextOp(current, target), version);
      } catch (err: any) {
        if (!/version/i.test(String(err?.message ?? err))) throw err;
        const fresh = await s.joinDoc(docId);
        if (fresh.lines.join("\n") === target) return;
        assertUnchanged(fresh.lines.join("\n"));
        const op = computeTextOp(fresh.lines.join("\n"), target);
        if (op.length > 0) await s.applyOtUpdate(docId, op, fresh.version);
      }
      const applied = await s.joinDoc(docId);
      if (s.otUpdateError) throw s.otUpdateError;
      if (applied.lines.join("\n") !== target) {
        throw new Error("doc text did not match the edit after the ack");
      }
    } finally {
      await s.leaveDoc(docId).catch(() => {
        /* connection may already be gone — the next doc reopens it */
      });
    }
  };

  try {
    for (const change of changes) {
      if (change.status === "delete") {
        const t = await getTree();
        const entity = t?.entities.get(change.path);
        if (!entity) {
          result.warnings.push(`${change.path}: not found on Overleaf — delete it manually if it still exists`);
          continue;
        }
        await client.deleteEntity(remoteProjectId, entity.type, entity.id);
        result.deleted.push(change.path);
      } else {
        const content = await read(change.path);
        // Existing text docs are edited in place over the websocket — never
        // delete-and-reupload them, which would orphan comments and history.
        const entity = (await getTree())?.entities.get(change.path);
        if (entity?.type === "doc") {
          const target = decodeUtf8(content);
          if (target === null) {
            result.warnings.push(
              `${change.path}: not valid UTF-8 — replacing the whole doc instead; comments/tracked changes on ${change.path} may not survive`,
            );
          } else {
            try {
              await updateDocInPlace(entity.id, target, change.path);
              result.updatedInPlace.push(change.path);
              result.uploaded.push(change.path);
              continue;
            } catch (err: any) {
              if (err instanceof RemoteDocChangedError) {
                result.failed.push(change.path);
                result.warnings.push(
                  `${change.path}: a collaborator edited it on Overleaf during the approval — not overwritten; still pending, approve again to review the conflict`,
                );
                continue;
              }
              result.warnings.push(
                `${change.path}: in-place update failed (${err?.message ?? err}) — replacing the whole doc instead; comments/tracked changes on ${change.path} may not survive`,
              );
            }
          }
        }
        const fileDir = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
        let res = await client.uploadFile(remoteProjectId, change.path, content, await ensureFolderId(fileDir));
        if (res.duplicate) {
          // Server rejects same-name uploads: remove the existing entity, retry once.
          const t = await getTree();
          const dup = t?.entities.get(change.path);
          if (dup) {
            await client.deleteEntity(remoteProjectId, dup.type, dup.id);
            tree = null; // tree is stale now
            res = await client.uploadFile(remoteProjectId, change.path, content, await ensureFolderId(fileDir));
          }
        }
        if (res.ok) result.uploaded.push(change.path);
        else {
          result.failed.push(change.path);
          result.warnings.push(`${change.path}: upload failed (duplicate could not be replaced) — still pending, approve again to retry`);
        }
      }
    }
  } finally {
    closeSession();
  }
  return result;
}
