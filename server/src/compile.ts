import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BIN_DIR, buildDir } from "./config.js";
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
  const started = Date.now();
  const main = mainTex ?? findMainTex(projectPath);
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

  const outDir = buildDir(projectId);
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
      cwd: projectPath,
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
