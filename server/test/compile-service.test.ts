/**
 * Working-tree compiles with fake engines in BIN_DIR: the TeX program each
 * engine is asked for, latexmk's forced rebuild only after a refusal, reuse
 * of an unchanged build, one build at a time per project, and the last result
 * surviving a restart.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let projectId: string;
let projectPath: string;
let service: typeof import("../src/compile-service.js");
let compile: typeof import("../src/compile.js");

const runlog = () => join(dataDir, "runlog");

/** A fake engine: logs "<name> <args…>" plus start/end times, then runs `body`. */
function fakeEngine(name: string, body: string): void {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const main = args[args.length - 1];",
    "const flag = args.find((a) => a.startsWith('-outdir=') || a.startsWith('-output-directory='));",
    "const out = flag ? flag.split('=')[1] : args[args.indexOf('--outdir') + 1];",
    "const pdf = path.join(out, path.basename(main, '.tex') + '.pdf');",
    `const log = (line) => fs.appendFileSync(${JSON.stringify(runlog())}, line + '\\n');`,
    `log(${JSON.stringify(name)} + ' ' + args.filter((a) => !a.startsWith('-outdir=') && !a.startsWith('-output-directory=')).join(' '));`,
    "log('start ' + Date.now());",
    body,
    "",
  ].join("\n");
  const bin = join(dataDir, "bin");
  if (process.platform === "win32") {
    writeFileSync(join(bin, `${name}.js`), script);
    writeFileSync(join(bin, `${name}.cmd`), `@node "%~dp0${name}.js" %*\r\n`);
  } else {
    writeFileSync(join(bin, name), `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  }
}

const writesPdf = "fs.writeFileSync(pdf, '%PDF-1.4 fake\\n'); log('end ' + Date.now());";
const slowPdf = `setTimeout(() => { ${writesPdf} }, 400);`;

function runs(): string[] {
  return existsSync(runlog()) ? readFileSync(runlog(), "utf8").split("\n").filter(Boolean) : [];
}
const engineRuns = () => runs().filter((l) => !/^(start|end) /.test(l));

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-compile-service-"));
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
  const config = await import("../src/config.js");
  const project = config.addProject({ name: "Compile", gitUrl: "local", kind: "local", mainTex: "main.tex" });
  projectId = project.id;
  projectPath = config.projectDir(project.id);
  mkdirSync(projectPath, { recursive: true });
  service = await import("../src/compile-service.js");
  compile = await import("../src/compile.js");
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  rmSync(runlog(), { force: true });
  compile.resetEngineCache();
  for (const name of ["latexmk", "pdflatex", "xelatex", "lualatex", "tectonic"]) {
    rmSync(join(dataDir, "bin", name), { force: true });
    rmSync(join(dataDir, "bin", `${name}.cmd`), { force: true });
  }
});

let counter = 0;
/** New content, so no earlier build can be reused. */
function writeMain(prefix = ""): void {
  writeFileSync(join(projectPath, "main.tex"), `${prefix}\\documentclass{article}\n\\begin{document}${++counter}\\end{document}\n`);
}

describe("TeX program", () => {
  it("asks latexmk for the program of the magic comment, without forcing a rebuild", async () => {
    fakeEngine("latexmk", writesPdf);
    writeMain("% !TEX program = xelatex\n");
    const r = await service.compileWorkingTree(projectId);
    expect(r).toMatchObject({ ok: true, engine: "latexmk", program: "xelatex", programSource: "magic comment" });
    expect(engineRuns()).toEqual(["latexmk -xelatex -interaction=nonstopmode -halt-on-error main.tex"]);
  });

  it("uses the Overleaf project's compiler when the main file names none", async () => {
    fakeEngine("latexmk", writesPdf);
    const config = await import("../src/config.js");
    config.updateProject(projectId, { overleafCompiler: "lualatex" });
    try {
      writeMain();
      const r = await service.compileWorkingTree(projectId);
      expect(r).toMatchObject({ ok: true, program: "lualatex", programSource: "Overleaf" });
      expect(engineRuns()).toEqual(["latexmk -lualatex -interaction=nonstopmode -halt-on-error main.tex"]);
      // The magic comment still wins.
      rmSync(runlog(), { force: true });
      writeMain("% !TEX program = pdflatex\n");
      expect(await service.compileWorkingTree(projectId)).toMatchObject({ program: "pdflatex", programSource: "magic comment" });
    } finally {
      config.updateProject(projectId, { overleafCompiler: undefined });
    }
  });

  it("forces a rebuild only when latexmk refuses after an earlier failure", async () => {
    fakeEngine(
      "latexmk",
      "if (!args.includes('-g')) { process.stdout.write(\"Latexmk: Nothing to do for 'main.tex'.\\nLatexmk: gave an error in previous invocation of latexmk.\\n\"); process.exit(12); }\n" +
        writesPdf,
    );
    writeMain();
    const r = await service.compileWorkingTree(projectId);
    expect(r.ok).toBe(true);
    expect(engineRuns()).toEqual([
      "latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex",
      "latexmk -g -pdf -interaction=nonstopmode -halt-on-error main.tex",
    ]);
  });

  it("switches an undeclared fontspec document to XeLaTeX", async () => {
    fakeEngine(
      "latexmk",
      "if (args.includes('-pdf')) { process.stdout.write('! Fatal Package fontspec Error: The fontspec package requires either XeTeX or\\n(fontspec) LuaTeX.\\n'); process.exit(1); }\n" +
        writesPdf,
    );
    writeMain();
    const r = await service.compileWorkingTree(projectId);
    expect(r).toMatchObject({ ok: true, engine: "latexmk", program: "xelatex", programSource: "log" });
    expect(engineRuns()).toEqual([
      "latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex",
      "latexmk -xelatex -interaction=nonstopmode -halt-on-error main.tex",
    ]);
  });
});

describe("reuse and the per-project lock", () => {
  it("reuses the last successful build of unchanged sources unless forced", async () => {
    fakeEngine("latexmk", writesPdf);
    writeMain();
    const first = await service.compileWorkingTree(projectId);
    const again = await service.compileWorkingTree(projectId);
    expect(again).toMatchObject({ reused: true, version: first.version });
    expect(engineRuns()).toHaveLength(1);
    const forced = await service.compileWorkingTree(projectId, { force: true });
    expect(forced.version).not.toBe(first.version);
    expect(engineRuns()).toHaveLength(2);
  });

  it("joins a running build of the same content and queues a different one", async () => {
    fakeEngine("latexmk", slowPdf);
    writeMain();
    const [a, b] = await Promise.all([service.compileWorkingTree(projectId), service.compileWorkingTree(projectId)]);
    expect(a.version).toBe(b.version);
    expect(engineRuns()).toHaveLength(1);

    rmSync(runlog(), { force: true });
    writeMain();
    const first = service.compileWorkingTree(projectId);
    expect(service.isCompiling(projectId)).toBe(true);
    for (let i = 0; i < 200 && !runs().some((l) => l.startsWith("start ")); i++) await new Promise((r) => setTimeout(r, 10));
    writeMain();
    const second = service.compileWorkingTree(projectId);
    await Promise.all([first, second]);
    const times = runs().filter((l) => /^(start|end) /.test(l));
    expect(times.map((l) => l.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
    expect(Number(times[2].split(" ")[1])).toBeGreaterThanOrEqual(Number(times[1].split(" ")[1]));
    expect(service.isCompiling(projectId)).toBe(false);
    await service.compileIdle(projectId);
  });
});

describe("the last result after a restart", () => {
  it("is read back from the build dir, or found from the PDF there", async () => {
    fakeEngine("latexmk", writesPdf);
    writeMain();
    const built = await service.compileWorkingTree(projectId);
    vi.resetModules();
    const restarted = await import("../src/compile-service.js");
    const last = restarted.getLastCompile(projectId)!;
    expect(last).toMatchObject({ ok: true, version: built.version, pdfPath: built.pdfPath });
    expect(restarted.publicCompile(last)).toMatchObject({ hasPdf: true, pdfVersion: built.version });
    // Unchanged sources reuse it — no rebuild after the restart.
    expect((await restarted.compileWorkingTree(projectId)).reused).toBe(true);

    rmSync(join(dataDir, "builds", projectId, "last-compile.json"));
    vi.resetModules();
    const fresh = await import("../src/compile-service.js");
    expect(fresh.getLastCompile(projectId)).toMatchObject({ ok: true, engine: "cached", pdfPath: built.pdfPath });
  });
});
