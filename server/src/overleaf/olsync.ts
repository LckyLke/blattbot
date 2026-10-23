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
import { CONFLICT_LABELS, describeConflict, type RemoteConflict } from "../conflicts.js";
import { mergeText } from "../merge.js";
import { generateIdSeed, type OverleafClient, type OlDocSnapshot, type OlRealtimeSession, type ProjectTree } from "./olclient.js";
import { computeTextOpHunks, historyTextOperation } from "./ot.js";
import { projectMetaFromTree, type OverleafProjectMeta } from "./metadata.js";

export interface SyncInResult {
  changed: boolean;
  /** Remote-changed paths whose Overleaf version is now in the mirror (local edits were pending). */
  merged?: string[];
  /**
   * Of `merged`: files that also had local edits, merged line by line. HEAD
   * holds Overleaf's version; the local edits stay pending on top.
   */
  rebased?: string[];
  /** Remote-changed paths left untouched: their local edits overlap (or a side is binary or deleted). */
  drift?: string[];
  /** What overlaps in each drift path. */
  conflicts?: RemoteConflict[];
  /** HEAD now holds Overleaf's version of every changed file — nothing was left behind. */
  inSync: boolean;
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
  return git.commitAll(dir, message, git.OVERLEAF_AUTHOR);
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
  writeRemoteVersions(dir, snapshot, paths);
  return git.commitPaths(dir, message, paths, git.OVERLEAF_AUTHOR);
}

/** Write Overleaf's version of `paths` into the worktree (deleting what it no longer has). */
function writeRemoteVersions(dir: string, snapshot: Map<string, Buffer>, paths: string[]): void {
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
}

/** A worktree file's bytes; null when it does not exist. */
export function readWorktree(dir: string, rel: string): Buffer | null {
  try {
    return readFileSync(join(dir, rel));
  } catch {
    return null;
  }
}

/** A file whose local edits are kept on top of Overleaf's version. */
export interface RebasedFile {
  /** The worktree text to write once HEAD holds Overleaf's version. */
  content: Buffer;
  /** The worktree text before, restored if the step cannot be completed. */
  original: Buffer;
}

/**
 * Bring Overleaf's version of some paths into HEAD as ONE sync commit of
 * only those paths. `plain` paths also take it in the worktree; `rebased`
 * paths get their own worktree text (a line merge), so their local edits
 * stay pending on top of Overleaf's version. The commit is built off-index,
 * so the worktree never loses the local edits in between.
 */
export async function applyRemoteVersions(
  dir: string,
  snapshot: Map<string, Buffer>,
  plain: string[],
  rebased: Map<string, RebasedFile>,
  message = "Sync from Overleaf",
): Promise<boolean> {
  const paths = [...plain, ...rebased.keys()];
  if (paths.length === 0) return false;
  // Untouched paths first: if this fails HEAD stays put, and what was
  // written equals Overleaf's version, which the next sync recognises.
  writeRemoteVersions(dir, snapshot, plain);
  const head = await git.revParse(dir, "HEAD");
  const changed = await git.commitContents(
    dir,
    message,
    new Map(paths.map((p) => [p, snapshot.get(p) ?? null])),
    git.OVERLEAF_AUTHOR,
  );
  await git.resetIndexPaths(dir, paths);
  try {
    for (const [rel, file] of rebased) writeFileSync(join(dir, rel), file.content);
  } catch (err) {
    // HEAD on Overleaf's version under the OLD local text would read as a
    // pending edit that reverts the co-author's change — undo the commit.
    await git.resetSoft(dir, head);
    await git.resetIndexPaths(dir, paths);
    for (const [rel, file] of rebased) {
      try {
        writeFileSync(join(dir, rel), file.original);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
  return changed;
}

export interface RemoteMergeResult {
  changed: boolean;
  /** Paths whose Overleaf version is now in HEAD (untouched and rebased ones). */
  merged: string[];
  rebased: string[];
  drift: string[];
  conflicts: RemoteConflict[];
  /** Pending paths that already hold exactly Overleaf's version (HEAD still differs). */
  pendingSame: string[];
}

/**
 * Bring Overleaf's changes to `paths` into a mirror with pending edits.
 * Paths without local edits take the remote version. Paths with local edits
 * are merged line by line (base = HEAD, yours = worktree, Overleaf = the
 * snapshot): on a clean merge HEAD takes Overleaf's version and the worktree
 * the merged text, so the local edits stay pending on top. Overlapping
 * edits, binary files and delete-vs-modify are left untouched and reported.
 */
export async function mergeRemoteChanges(
  dir: string,
  snapshot: Map<string, Buffer>,
  paths: string[],
  local: Set<string>,
  message = "Sync from Overleaf",
): Promise<RemoteMergeResult> {
  const plain: string[] = [];
  const rebased = new Map<string, RebasedFile>();
  const drift: string[] = [];
  const conflicts: RemoteConflict[] = [];
  const pendingSame: string[] = [];
  for (const rel of paths) {
    if (!local.has(rel)) {
      plain.push(rel);
      continue;
    }
    const remote = snapshot.get(rel) ?? null;
    // Already identical on both sides (e.g. pushed before a failed approve
    // was rolled back) — pending locally, but not drift.
    if (sameAsWorktree(dir, rel, remote ?? undefined)) {
      pendingSame.push(rel);
      continue;
    }
    const base = await git.readBlob(dir, "HEAD", rel);
    const mine = readWorktree(dir, rel);
    const merged = base && mine && remote ? await mergeText(base, mine, remote, CONFLICT_LABELS) : null;
    if (merged && merged.conflicts === 0) {
      rebased.set(rel, { content: merged.content, original: mine! });
      continue;
    }
    drift.push(rel);
    conflicts.push(await describeConflict(rel, base, mine, remote));
  }
  const changed = await applyRemoteVersions(dir, snapshot, plain, rebased, message);
  return { changed, merged: [...plain, ...rebased.keys()], rebased: [...rebased.keys()], drift, conflicts, pendingSame };
}

/**
 * Pull the latest server state into the local mirror. With a clean tree the
 * whole snapshot lands as one sync commit; with pending local edits the
 * remote changes are merged in (see mergeRemoteChanges) and only paths whose
 * edits overlap are reported as drift, their local content untouched.
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
    return { changed, inSync: true };
  }
  const local = new Set(await git.changedPaths(dir));
  const remote = await scanRemoteDrift(dir, snapshot);
  const result = await mergeRemoteChanges(dir, snapshot, [...remote.keys()], local);
  return {
    changed: result.changed,
    ...(result.merged.length > 0 ? { merged: result.merged } : {}),
    ...(result.rebased.length > 0 ? { rebased: result.rebased } : {}),
    ...(result.drift.length > 0 ? { drift: result.drift, conflicts: result.conflicts } : {}),
    inSync: result.drift.length === 0 && result.pendingSame.length === 0,
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
  /** Overleaf's compiler / root document, read from the project join the push made anyway. */
  remoteMeta?: OverleafProjectMeta;
}

export interface PushOptions {
  /**
   * Send in-place doc edits as tracked changes (`meta.tc`), one change per
   * edited region. Experimental: whether an instance records them is checked
   * after each doc and reported. Uploads, deletions and history-OT docs
   * cannot be tracked; they get a warning instead.
   */
  trackChanges?: boolean;
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
  opts: PushOptions = {},
): Promise<PushResult> {
  const nameStatus = await git.diffNameStatus(dir, fromRef, toRef);
  // Content comes from the commit, not the worktree: after a partial approval
  // the worktree still holds edits that were not approved.
  const read = async (path: string) => {
    const content = await git.readBlob(dir, toRef, path);
    if (!content) throw new Error(`${path} is missing from the approved commit`);
    return content;
  };
  return applyChanges(client, remoteProjectId, read, parseNameStatus(nameStatus), checkedSnapshot, opts);
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
  opts: PushOptions = {},
): Promise<PushResult> {
  const result: PushResult = { uploaded: [], updatedInPlace: [], deleted: [], failed: [], warnings: [] };
  if (changes.length === 0) return result;
  const track = opts.trackChanges === true;

  let tree: ProjectTree | null = null;
  const getTree = async (): Promise<ProjectTree | null> => {
    if (tree) return tree;
    try {
      tree = await client.joinProjectTree(remoteProjectId);
      result.remoteMeta ??= projectMetaFromTree(tree);
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
   *
   * History-OT docs (newer Overleaf) take history text operations instead of
   * sharejs ops; the same verification applies. With `track`, sharejs ops
   * carry `meta.tc` and the re-join checks Overleaf recorded the change.
   */
  const updateDocInPlace = async (docId: string, target: string, path: string): Promise<void> => {
    const s = await getSession();
    const doc = await s.joinDoc(docId);
    const checked = checkedSnapshot ? decodeUtf8(checkedSnapshot.get(path) ?? Buffer.alloc(0)) : null;
    const assertUnchanged = (live: string) => {
      if (checkedSnapshot && !checkedSnapshot.has(path)) throw new RemoteDocChangedError();
      if (checked !== null && !sameDocText(live, checked)) throw new RemoteDocChangedError();
    };
    /** Tracked-change id seeds sent in this doc's updates. */
    const seeds: string[] = [];
    const send = async (live: OlDocSnapshot): Promise<void> => {
      const text = live.lines.join("\n");
      if (live.type === "history-ot") {
        await s.applyHistoryOtUpdate(docId, historyTextOperation(live.historyContent ?? text, live.hiddenSpans ?? [], target), live.version);
      } else if (track) {
        const tc = generateIdSeed();
        seeds.push(tc);
        await s.applyOtUpdate(docId, computeTextOpHunks(text, target), live.version, { tc });
      } else {
        // One edit per changed region (not one splice from the first change
        // to the last), so comments anchored in untouched text between two
        // edits keep their range.
        await s.applyOtUpdate(docId, computeTextOpHunks(text, target), live.version);
      }
    };
    try {
      const current = doc.lines.join("\n");
      if (current === target) return; // remote already matches
      assertUnchanged(current);
      try {
        await send(doc);
      } catch (err: any) {
        if (!/version/i.test(String(err?.message ?? err))) throw err;
        const fresh = await s.joinDoc(docId);
        if (fresh.lines.join("\n") === target) return;
        assertUnchanged(fresh.lines.join("\n"));
        await send(fresh);
      }
      const applied = await s.joinDoc(docId);
      if (s.otUpdateError) throw s.otUpdateError;
      if (applied.lines.join("\n") !== target) {
        throw new Error("doc text did not match the edit after the ack");
      }
      if (track && doc.type === "history-ot") {
        result.warnings.push(
          `${path}: this document uses Overleaf's newer history format, which BlattBot cannot push as tracked changes; the edit was applied as a normal edit`,
        );
      } else if (track && !applied.ranges.changes.some((c) => seeds.some((seed) => c.id.startsWith(seed)))) {
        result.warnings.push(
          `This Overleaf instance did not record tracked changes for ${path}; the edit was applied as a normal edit`,
        );
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
        if (track) result.warnings.push(`${change.path}: deleted on Overleaf — deleting a file cannot be a tracked change`);
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
              if (track) {
                // Replacing the whole doc would be neither tracked nor keep its comments.
                result.failed.push(change.path);
                result.warnings.push(
                  `${change.path}: pushing it as a tracked change failed (${err?.message ?? err}) — not replaced as a whole file; still pending. Approve again to retry, or turn off "Push changes to Overleaf as tracked changes" in Project settings to push it as a normal edit`,
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
        if (res.ok) {
          result.uploaded.push(change.path);
          if (track) {
            result.warnings.push(
              `${change.path}: uploaded as a whole file — Overleaf records only edits inside existing documents as tracked changes, not uploads`,
            );
          }
        } else {
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
