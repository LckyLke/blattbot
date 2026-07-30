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
import { OverleafClient, type ProjectTree } from "./olclient.js";

export interface SyncInResult {
  changed: boolean;
  skipped?: "dirty";
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

/** Pull the latest server state into the local mirror (no-op if the tree is dirty). */
export async function syncIn(client: OverleafClient, remoteProjectId: string, dir: string): Promise<SyncInResult> {
  if (await git.hasChanges(dir)) return { changed: false, skipped: "dirty" };
  const zip = await client.downloadZip(remoteProjectId);
  const snapshot = unpackZip(zip);
  const changed = await applySnapshot(dir, snapshot, "Sync from Overleaf");
  return { changed };
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
  uploaded: string[];
  deleted: string[];
  warnings: string[];
}

/**
 * Replay a committed change set (fromRef → toRef) onto the Overleaf project.
 * Uploads replace existing entities (delete-then-upload when the server
 * rejects duplicates); deletions resolve entity ids via the realtime tree.
 */
export async function pushChanges(
  client: OverleafClient,
  remoteProjectId: string,
  dir: string,
  fromRef: string,
  toRef: string,
): Promise<PushResult> {
  const nameStatus = await git.diffNameStatus(dir, fromRef, toRef);
  return applyChanges(client, remoteProjectId, dir, parseNameStatus(nameStatus));
}

/** Upload the entire working tree (used when publishing a local project). */
export async function pushAll(
  client: OverleafClient,
  remoteProjectId: string,
  dir: string,
): Promise<PushResult> {
  const changes: PushChange[] = listFiles(dir).map((path) => ({ status: "upload", path }));
  return applyChanges(client, remoteProjectId, dir, changes);
}

async function applyChanges(
  client: OverleafClient,
  remoteProjectId: string,
  dir: string,
  changes: PushChange[],
): Promise<PushResult> {
  const result: PushResult = { uploaded: [], deleted: [], warnings: [] };
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
      const content = readFileSync(join(dir, change.path));
      const fileDir = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
      let res = await client.uploadFile(remoteProjectId, change.path, content, await ensureFolderId(fileDir));
      if (res.duplicate) {
        // Server rejects same-name uploads: remove the existing entity, retry once.
        const t = await getTree();
        const entity = t?.entities.get(change.path);
        if (entity) {
          await client.deleteEntity(remoteProjectId, entity.type, entity.id);
          tree = null; // tree is stale now
          res = await client.uploadFile(remoteProjectId, change.path, content, await ensureFolderId(fileDir));
        }
      }
      if (res.ok) result.uploaded.push(change.path);
      else result.warnings.push(`${change.path}: upload failed (duplicate could not be replaced)`);
    }
  }
  return result;
}
