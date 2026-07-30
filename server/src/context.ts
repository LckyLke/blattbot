/**
 * External read-only context for a project: reference material the agent may
 * read but never edit, and that never syncs to Overleaf.
 *  - links:   user-chosen local paths (a code repo, a results folder, a PDF)
 *  - uploads: files copied into DATA_DIR/context/<projectId>/ (papers, notes)
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DATA_DIR, projectDir, type Project } from "./config.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function contextUploadsDir(projectId: string): string {
  return join(DATA_DIR, "context", projectId);
}

export interface ContextLink {
  path: string;
  exists: boolean;
  kind: "dir" | "file" | "missing";
}

export interface ContextUpload {
  name: string;
  size: number;
}

export interface ProjectContext {
  links: ContextLink[];
  uploads: ContextUpload[];
}

export function listContext(project: Project): ProjectContext {
  const links: ContextLink[] = (project.contextPaths ?? []).map((p) => {
    try {
      const st = statSync(p);
      return { path: p, exists: true, kind: st.isDirectory() ? "dir" : "file" };
    } catch {
      return { path: p, exists: false, kind: "missing" };
    }
  });
  const uploads: ContextUpload[] = [];
  const dir = contextUploadsDir(project.id);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      try {
        const st = statSync(join(dir, name));
        if (st.isFile()) uploads.push({ name, size: st.size });
      } catch {
        /* raced away */
      }
    }
  }
  return { links, uploads };
}

/** Validate a user-supplied path for linking. Returns the normalized path. */
export function validateLinkPath(project: Project, raw: string): string {
  const p = resolve(raw.trim());
  if (!isAbsolute(p)) throw new Error("path must be absolute");
  if (!existsSync(p)) throw new Error(`path does not exist: ${p}`);
  const mirror = projectDir(project.id);
  if (p === mirror || p.startsWith(mirror + "/")) {
    throw new Error("that path is inside the project itself — it is already available");
  }
  return p;
}

/** Keep upload names flat and filesystem-safe. */
export function sanitizeUploadName(raw: string): string {
  const name = raw.trim().split("/").pop()!.split("\\").pop()!.replace(/[\0-\x1f]/g, "");
  if (!name || name === "." || name === "..") throw new Error("invalid file name");
  if (name.startsWith(".")) throw new Error("hidden file names are not allowed");
  if (name.length > 150) throw new Error("file name too long");
  return name;
}

export function saveUpload(projectId: string, name: string, content: Buffer): ContextUpload {
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new Error(`file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`);
  }
  const dir = contextUploadsDir(projectId);
  mkdirSync(dir, { recursive: true });
  const clean = sanitizeUploadName(name);
  writeFileSync(join(dir, clean), content);
  return { name: clean, size: content.length };
}

export function deleteUpload(projectId: string, name: string): boolean {
  const clean = sanitizeUploadName(name);
  const target = join(contextUploadsDir(projectId), clean);
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}

export function uploadPath(projectId: string, name: string): string {
  return join(contextUploadsDir(projectId), sanitizeUploadName(name));
}

/** Directories the agent should see read-only (existing ones only). */
export function contextDirectories(project: Project): string[] {
  const dirs: string[] = [];
  for (const link of project.contextPaths ?? []) {
    if (existsSync(link)) dirs.push(link);
  }
  const uploads = contextUploadsDir(project.id);
  if (existsSync(uploads)) dirs.push(uploads);
  return dirs;
}
