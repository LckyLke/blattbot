/**
 * External read-only context for a project: reference material the agent may
 * read but never edit, and that never syncs to Overleaf.
 *  - links:   user-chosen local paths (a code repo, a results folder, a PDF)
 *  - uploads: files copied into DATA_DIR/context/<projectId>/ (papers, notes)
 *
 * A linked folder is meant to be the real thing — the paper's codebase, the
 * experiment directory — so nothing here copies or snapshots it. Everything is
 * read from disk on demand: listContext for the UI, contextDirectories for the
 * agent's read roots, and scanContextDir/formatContextManifest for the listing
 * that goes into the system prompt at the start of every turn, so a repo that
 * changed since the last turn is described as it is now.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { DATA_DIR, projectDir, type Project } from "./config.js";
import { secretRoots } from "./backends/paths.js";

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
  if (p === mirror || p.startsWith(mirror + sep)) {
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

// ---- Manifest: what a linked directory actually contains --------------------

/**
 * Vendored and build-output directories: linking a real codebase otherwise
 * buries its source under thousands of dependency files. Skipped by name at
 * any depth, as are dot-directories (see scanContextDir) — kept deliberately
 * short, since this only shapes the listing the agent is handed, and hiding a
 * directory that does hold source is the worse error. Grep and Glob still
 * reach everything.
 */
export const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  "venv",
  "__pycache__",
  "site-packages",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
]);

/** Entries listed across ALL linked directories in one turn's manifest. */
export const MANIFEST_MAX_ENTRIES = 200;
/** Never list more than this per single directory, however few are linked. */
export const MANIFEST_MAX_PER_DIR = 120;
/** How deep the walk descends before summarizing a subtree as `path/…`. */
export const MANIFEST_MAX_DEPTH = 4;
/** Extensions named in a directory's one-line summary. */
const MANIFEST_MAX_EXTENSIONS = 6;

export interface ContextManifest {
  root: string;
  kind: "dir" | "file" | "missing";
  /** Relative POSIX paths: files as-is, unexpanded subtrees as `path/…`. */
  entries: string[];
  /** Files seen by the walk (may exceed entries.length once capped). */
  fileCount: number;
  /** True when entries is a partial view of the tree. */
  truncated: boolean;
  /** Most common file extensions, most frequent first. */
  extensions: { ext: string; count: number }[];
  /** Names of directories left out (node_modules, .git, …), for honesty. */
  skipped: string[];
}

/**
 * Walk a linked path into a compact manifest. Breadth-first, so the cap costs
 * depth rather than the top-level shape a reader needs most; symlinks are
 * never followed (readdir's Dirent reports them as neither file nor dir),
 * which also makes cycles impossible.
 */
export function scanContextDir(
  root: string,
  maxEntries: number = MANIFEST_MAX_PER_DIR,
  maxDepth: number = MANIFEST_MAX_DEPTH,
): ContextManifest {
  const manifest: ContextManifest = {
    root,
    kind: "dir",
    entries: [],
    fileCount: 0,
    truncated: false,
    extensions: [],
    skipped: [],
  };
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return { ...manifest, kind: "missing" };
  }
  if (!stat.isDirectory()) return { ...manifest, kind: "file", fileCount: 1 };

  const counts = new Map<string, number>();
  const skipped = new Set<string>();
  const unexpanded: string[] = [];
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (manifest.entries.length >= maxEntries) {
      // Out of budget before this directory was opened — name it unexpanded
      // rather than pretending the tree ends here.
      if (cur.rel) unexpanded.push(cur.rel);
      continue;
    }
    let dirents;
    try {
      dirents = readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      continue; // unreadable (permissions, raced away) — skip it silently
    }
    for (const d of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (d.name.startsWith(".") || SKIPPED_DIR_NAMES.has(d.name)) {
          skipped.add(d.name);
        } else if (cur.depth + 1 > maxDepth) {
          unexpanded.push(rel);
        } else {
          queue.push({ abs: join(cur.abs, d.name), rel, depth: cur.depth + 1 });
        }
      } else if (d.isFile() && !d.name.startsWith(".")) {
        manifest.fileCount++;
        const ext = extname(d.name).toLowerCase() || "(no extension)";
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
        if (manifest.entries.length < maxEntries) manifest.entries.push(rel);
        else manifest.truncated = true;
      }
    }
  }

  manifest.entries.push(...unexpanded.map((rel) => `${rel}/…`));
  manifest.entries.sort((a, b) => a.localeCompare(b));
  manifest.truncated = manifest.truncated || unexpanded.length > 0;
  manifest.skipped = [...skipped].sort();
  manifest.extensions = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MANIFEST_MAX_EXTENSIONS)
    .map(([ext, count]) => ({ ext, count }));
  return manifest;
}

/** One manifest as prompt lines: a header, the listing, and what was left out. */
export function formatManifest(manifest: ContextManifest): string {
  if (manifest.kind === "missing") return `${manifest.root} — no longer exists`;
  if (manifest.kind === "file") return `${manifest.root} — single file`;
  const exts = manifest.extensions.map((e) => `${e.ext} ×${e.count}`).join(", ");
  const header =
    `${manifest.root} — ${manifest.fileCount} file${manifest.fileCount === 1 ? "" : "s"}` +
    (exts ? ` (${exts})` : "");
  const lines = [header, ...manifest.entries.map((e) => `    ${e}`)];
  const notes: string[] = [];
  if (manifest.truncated) notes.push("listing shortened — use Glob/Grep for the rest");
  if (manifest.skipped.length > 0) notes.push(`not listed: ${manifest.skipped.join(", ")}`);
  if (notes.length > 0) lines.push(`    (${notes.join("; ")})`);
  return lines.join("\n");
}

/**
 * The listing of every attached context path, for the system prompt. Scanned
 * fresh on each call — the manifest describes the directories as they are at
 * the start of this turn, not as they were when they were linked. The overall
 * entry budget is split across the linked paths so attaching five repos does
 * not multiply the prompt by five.
 */
export function formatContextManifest(dirs: string[]): string {
  if (dirs.length === 0) return "";
  const perDir = Math.min(
    MANIFEST_MAX_PER_DIR,
    Math.max(20, Math.floor(MANIFEST_MAX_ENTRIES / dirs.length)),
  );
  return dirs.map((d) => formatManifest(scanContextDir(d, perDir))).join("\n");
}

// ---- Folder picker ----------------------------------------------------------

/** Subdirectories listed in one browse step (a plausible ceiling, not a limit users hit). */
export const BROWSE_MAX_ENTRIES = 500;

export interface DirListing {
  path: string;
  /** Parent directory, or null at the filesystem root. */
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}

/**
 * List the subdirectories of `raw` (default: the user's home) so the UI can
 * offer a folder picker — a browser file input cannot return a real path, and
 * typing an absolute path by hand is the wrong ask for "link my codebase".
 *
 * Directories only: this never reveals file names, and the credential stores
 * and BlattBot data directories from secretRoots() are neither listed nor
 * enterable, matching the fence the agent itself runs behind. Hidden
 * directories are omitted; they stay reachable by typing the path.
 */
export function browseDirectories(raw?: string): DirListing {
  const target = raw?.trim() ? resolve(raw.trim()) : homedir();
  if (!isAbsolute(target)) throw new Error("path must be absolute");
  const secrets = secretRoots();
  const blocked = (p: string) => secrets.some((s) => p === s || p.startsWith(s + sep));
  if (blocked(target)) {
    throw new Error("that folder holds credentials or BlattBot's own data — it cannot be browsed");
  }
  let stat;
  try {
    stat = statSync(target);
  } catch {
    throw new Error(`no such folder: ${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a folder: ${target}`);

  const entries: { name: string; path: string }[] = [];
  let truncated = false;
  for (const d of readdirSync(target, { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue;
    const abs = join(target, d.name);
    // Symlinked directories are followed here (a linked repo is often one);
    // the manifest walk deliberately does not follow them.
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue; // dangling symlink
      }
    }
    if (!isDir || blocked(abs)) continue;
    if (entries.length >= BROWSE_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name: d.name, path: abs });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries, truncated };
}
