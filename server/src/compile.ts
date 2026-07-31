import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { BIN_DIR, buildDir } from "./config.js";
import { archiveZip } from "./git.js";
import { findMainTex } from "./latex.js";
import { loadSettings } from "./settings.js";

const execFileP = promisify(execFile);

export interface CompileResult {
  ok: boolean;
  engine: string;
  mainTex: string;
  pdfPath?: string;
  /** Human-readable error excerpts, empty when ok. */
  errors: string[];
  /** Tail of the raw log, for the curious. */
  logTail: string;
  durationMs: number;
}

let cachedEngine: { name: string; path: string } | null | undefined;

/** Forget the auto-detect result — call after installing an engine into BIN_DIR. */
export function resetEngineCache(): void {
  cachedEngine = undefined;
}

async function which(cmd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("which", [cmd]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function findEngine(name: string): Promise<{ name: string; path: string } | undefined> {
  const local = join(BIN_DIR, name);
  if (existsSync(local)) return { name, path: local };
  const p = await which(name);
  return p ? { name, path: p } : undefined;
}

export async function detectEngine(preferred?: string): Promise<{ name: string; path: string } | null> {
  // An explicit preference (Settings → engine) bypasses the auto-detect cache.
  if (preferred) {
    const hit = await findEngine(preferred);
    if (hit) return hit;
  }
  if (cachedEngine !== undefined) return cachedEngine;
  for (const name of ["tectonic", "latexmk", "pdflatex"]) {
    const hit = await findEngine(name);
    if (hit) {
      cachedEngine = hit;
      return cachedEngine;
    }
  }
  cachedEngine = null;
  return null;
}

/** Pull error lines out of a LaTeX/tectonic log. */
export function parseErrors(log: string): string[] {
  const errors: string[] = [];
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // tectonic style: "error: ..." — classic TeX style: lines starting with "!"
    if (/^error[:!]/i.test(line) || line.startsWith("! ")) {
      const context: string[] = [line.trim()];
      // Grab following l.<num> context lines that TeX prints after an error.
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j];
        if (/^(l\.\d+|<|\s*\^)/.test(next) || /^error/i.test(next) === false && next.trim().startsWith("l.")) {
          context.push(next.trim());
        } else if (next.trim() === "") {
          break;
        }
      }
      errors.push(context.join("\n"));
    }
  }
  return errors.slice(0, 20);
}

export async function compileProject(projectId: string, projectPath: string, mainTex?: string): Promise<CompileResult> {
  return compileTree(projectPath, buildDir(projectId), mainTex);
}

/** Run the detected engine on a source tree, PDF and logs into outDir. */
async function compileTree(sourceDir: string, outDir: string, mainTex?: string): Promise<CompileResult> {
  const started = Date.now();
  const main = mainTex ?? findMainTex(sourceDir);
  if (!main) {
    return {
      ok: false, engine: "none", mainTex: "", errors: ["No .tex file with \\documentclass found in the project."],
      logTail: "", durationMs: Date.now() - started,
    };
  }
  const engine = await detectEngine(loadSettings().engine || undefined);
  if (!engine) {
    return {
      ok: false, engine: "none", mainTex: main,
      errors: ["No LaTeX engine found. Install tectonic (recommended) or latexmk."],
      logTail: "", durationMs: Date.now() - started,
    };
  }

  mkdirSync(outDir, { recursive: true });

  let args: string[];
  if (engine.name === "tectonic") {
    args = ["--outdir", outDir, "--keep-logs", "--chatter", "minimal", main];
  } else if (engine.name === "latexmk") {
    args = ["-pdf", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outDir}`, main];
  } else {
    args = ["-interaction=nonstopmode", "-halt-on-error", `-output-directory=${outDir}`, main];
  }

  let combined = "";
  let ok = true;
  try {
    const { stdout, stderr } = await execFileP(engine.path, args, {
      cwd: sourceDir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
      env: { ...process.env, PATH: `${BIN_DIR}${delimiter}${process.env.PATH ?? ""}` },
    });
    combined = stdout + "\n" + stderr;
  } catch (err: any) {
    ok = false;
    combined = String(err.stdout ?? "") + "\n" + String(err.stderr ?? "") + "\n" + String(err.message ?? "");
  }

  // Include the .log file if the engine kept one — that's where TeX errors live.
  try {
    const logs = readdirSync(outDir).filter((f) => f.endsWith(".log"));
    for (const f of logs) combined += "\n" + readFileSync(join(outDir, f), "utf8");
  } catch {
    /* no log */
  }

  const pdfName = main.split("/").pop()!.replace(/\.tex$/, ".pdf");
  const pdfPath = join(outDir, pdfName);
  const pdfExists = existsSync(pdfPath);
  const errors = ok && pdfExists ? [] : parseErrors(combined);
  if (!ok && errors.length === 0) errors.push("Compilation failed — see log tail for details.");

  return {
    ok: ok && pdfExists,
    engine: engine.name,
    mainTex: main,
    pdfPath: pdfExists ? pdfPath : undefined,
    errors,
    logTail: combined.split("\n").slice(-60).join("\n"),
    durationMs: Date.now() - started,
  };
}

/** Fixed names inside a rev-<sha> build cache dir. */
const REV_PDF = "output.pdf";
const REV_RESULT = "result.json";
/** How many per-revision build caches to keep per project. */
const REV_CACHE_KEEP = 3;

/** Where compileRev leaves the PDF of a committed revision (may not exist yet). */
export function revPdfPath(projectId: string, sha: string): string {
  return join(buildDir(projectId), `rev-${sha}`, REV_PDF);
}

/**
 * Compile the project's tree AS COMMITTED at a sha (never the working copy):
 * `git archive` the revision into a per-sha cache dir under the build area and
 * run the engine there. A commit's tree is immutable, so an existing cached
 * PDF short-circuits the whole thing; failed builds are never cached.
 */
export async function compileRev(
  projectId: string,
  projectPath: string,
  sha: string,
  mainTex?: string,
): Promise<CompileResult> {
  const revDir = join(buildDir(projectId), `rev-${sha}`);
  const pdfPath = join(revDir, REV_PDF);
  if (existsSync(pdfPath)) {
    // Freshen the cache dir so eviction keeps recently USED revisions.
    const now = new Date();
    try {
      utimesSync(revDir, now, now);
    } catch {
      /* best effort */
    }
    let cached: Partial<CompileResult> = {};
    try {
      cached = JSON.parse(readFileSync(join(revDir, REV_RESULT), "utf8"));
    } catch {
      /* stale/corrupt sidecar — the PDF alone is enough */
    }
    return {
      ok: true,
      engine: typeof cached.engine === "string" ? cached.engine : "cached",
      mainTex: typeof cached.mainTex === "string" ? cached.mainTex : "",
      pdfPath,
      errors: [],
      logTail: typeof cached.logTail === "string" ? cached.logTail : "",
      durationMs: 0,
    };
  }

  // Materialize the committed tree next to where the PDF will land.
  const treeDir = join(revDir, "tree");
  rmSync(revDir, { recursive: true, force: true });
  mkdirSync(treeDir, { recursive: true });
  const entries = unzipSync(new Uint8Array(await archiveZip(projectPath, sha)));
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/") || name.split("/").includes("..")) continue;
    const dest = join(treeDir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(data));
  }

  // The registered main may not exist at this revision — fall back to detection.
  const main = mainTex && existsSync(join(treeDir, mainTex)) ? mainTex : undefined;
  const result = await compileTree(treeDir, revDir, main);
  if (result.pdfPath) {
    renameSync(result.pdfPath, pdfPath);
    result.pdfPath = pdfPath;
    const { pdfPath: _omit, ...rest } = result;
    writeFileSync(join(revDir, REV_RESULT), JSON.stringify(rest));
  }
  evictRevCaches(projectId);
  return result;
}

/** Drop all but the REV_CACHE_KEEP most recently touched rev caches of a project. */
function evictRevCaches(projectId: string): void {
  const dir = buildDir(projectId);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.startsWith("rev-"));
  } catch {
    return;
  }
  const dated = names
    .map((name) => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { name: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const e of dated.slice(REV_CACHE_KEEP)) {
    rmSync(join(dir, e.name), { recursive: true, force: true });
  }
}
