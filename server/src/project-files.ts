// Create, rename and delete files in a project's working tree on the user's
// behalf (the Source panel's file actions). The results are ordinary pending
// changes: they show in Proof and reach the remote only when approved.
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { assertNoSymlinkPath, isInside } from "./backends/paths.js";

/** A refused file operation, with the HTTP status the route answers. */
export class FileOpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
    this.name = "FileOpError";
  }
}

export const MAX_CREATED_FILE = 2 * 1024 * 1024;
const MAX_PATH = 1024;

/**
 * Validate a project-relative, "/"-separated path from the browser and
 * resolve it inside the working tree: no absolute paths, no "." / ".."
 * segments, never into a .git directory, never through a symlink.
 */
export function checkProjectPath(dir: string, raw: unknown): { rel: string; abs: string } {
  if (typeof raw !== "string") throw new FileOpError("path is required", 400);
  const rel = raw.trim().replace(/\\/g, "/");
  if (!rel) throw new FileOpError("path is required", 400);
  if (rel.length > MAX_PATH) throw new FileOpError("path is too long", 400);
  if (rel.includes("\0") || isAbsolute(rel) || rel.startsWith("/")) throw new FileOpError(`invalid path: ${rel}`, 400);
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new FileOpError(`invalid path: ${rel}`, 400);
  }
  if (segments.some((s) => s.toLowerCase() === ".git")) {
    throw new FileOpError("the .git directory is off-limits", 400);
  }
  const abs = resolve(dir, rel);
  if (abs === dir || !isInside(abs, dir)) throw new FileOpError(`paths must stay inside the project: ${rel}`, 400);
  if (isInside(abs, join(dir, ".git"))) throw new FileOpError("the .git directory is off-limits", 400);
  try {
    assertNoSymlinkPath(dir, abs);
  } catch (err: any) {
    if (err?.code === "ENOTDIR") throw new FileOpError(`a file is in the way of ${rel}`, 409);
    if (err?.code) throw err;
    throw new FileOpError(`symbolic links are not allowed in project file paths: ${rel}`, 400);
  }
  return { rel, abs };
}

function lstatOrNull(abs: string) {
  try {
    return lstatSync(abs);
  } catch {
    return null;
  }
}

/** The parent folders must be folders (or not exist yet), never files. */
function ensureParent(dir: string, abs: string): void {
  let parent = dirname(abs);
  const missing: string[] = [];
  while (parent !== dir && isInside(parent, dir)) {
    const st = lstatOrNull(parent);
    if (st && !st.isDirectory()) throw new FileOpError(`${parent.slice(dir.length + 1)} is a file, not a folder`, 409);
    if (st) break;
    missing.push(parent);
    parent = dirname(parent);
  }
  if (missing.length > 0) mkdirSync(dirname(abs), { recursive: true });
}

/** Remove folders left empty by a move or delete, up to (not including) the project root. */
function pruneEmptyParents(dir: string, abs: string): void {
  let parent = dirname(abs);
  while (parent !== dir && parent.startsWith(dir + sep)) {
    try {
      if (readdirSync(parent).length > 0) return;
      rmdirSync(parent);
    } catch {
      return;
    }
    parent = dirname(parent);
  }
}

function regularFile(abs: string, rel: string): void {
  const st = lstatOrNull(abs);
  if (!st) throw new FileOpError(`no such file: ${rel}`, 404);
  if (!st.isFile()) throw new FileOpError(`not a file: ${rel}`, 400);
}

/** Create a new file (and any missing folders on its path). */
export function createProjectFile(dir: string, rawPath: unknown, content: unknown = ""): string {
  const { rel, abs } = checkProjectPath(dir, rawPath);
  if (typeof content !== "string") throw new FileOpError("content must be a string", 400);
  if (Buffer.byteLength(content) > MAX_CREATED_FILE) throw new FileOpError("file too large", 413);
  if (lstatOrNull(abs)) throw new FileOpError(`${rel} already exists`, 409);
  ensureParent(dir, abs);
  try {
    writeFileSync(abs, content, { flag: "wx" });
  } catch (err: any) {
    if (err.code === "EEXIST") throw new FileOpError(`${rel} already exists`, 409);
    throw err;
  }
  return rel;
}

/** Rename or move a file; the target must not exist. */
export function renameProjectFile(dir: string, rawFrom: unknown, rawTo: unknown): { from: string; to: string } {
  const from = checkProjectPath(dir, rawFrom);
  const to = checkProjectPath(dir, rawTo);
  regularFile(from.abs, from.rel);
  if (from.rel === to.rel) throw new FileOpError("the new name is the same as the old one", 400);
  // A case-only rename on a case-insensitive disk finds the source itself.
  const target = lstatOrNull(to.abs);
  const sameFile = target && from.rel.toLowerCase() === to.rel.toLowerCase() && target.ino === lstatOrNull(from.abs)?.ino;
  if (target && !sameFile) throw new FileOpError(`${to.rel} already exists`, 409);
  ensureParent(dir, to.abs);
  renameSync(from.abs, to.abs);
  pruneEmptyParents(dir, from.abs);
  return { from: from.rel, to: to.rel };
}

/** Delete a file. */
export function deleteProjectFile(dir: string, rawPath: unknown): string {
  const { rel, abs } = checkProjectPath(dir, rawPath);
  regularFile(abs, rel);
  unlinkSync(abs);
  pruneEmptyParents(dir, abs);
  return rel;
}
