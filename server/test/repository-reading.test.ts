import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "blattbot-code-reading-"));
const source = join(root, "source");
let repos: typeof import("../src/repositories.js");
let executeTool: typeof import("../src/backends/openai.js").executeTool;
let repository: import("../src/repositories.js").CodeRepository;
let ctx: any;
const longLines = Array.from({ length: 901 }, (_, i) => `value_${i + 1} = ${i + 1}`);
const denseLines = Array.from({ length: 150 }, (_, i) => `${i}: ${'"\\'.repeat(500)}`);
const args = (action: string, extra = {}) => ({ action, repositoryId: repository.id, commit: repository.commit, ...extra });
async function inspect(action: string, extra = {}) {
  const result = await executeTool(ctx, "inspect_repository", args(action, extra));
  expect(result.isError, result.content).toBe(false);
  return JSON.parse(result.content);
}
beforeAll(async () => {
  vi.stubEnv("BLATTBOT_DATA_DIR", join(root, "data")); vi.resetModules();
  repos = await import("../src/repositories.js");
  ({ executeTool } = await import("../src/backends/openai.js"));
  const config = await import("../src/config.js");
  const project = config.addProject({ name: "Code reading", gitUrl: "local", kind: "local" });
  ctx = { project, dir: config.projectDir(project.id), readOnly: true, signal: new AbortController().signal, emit: vi.fn() };
  mkdirSync(join(source, "src"), { recursive: true }); mkdirSync(join(source, "src[legacy]"));
  writeFileSync(join(source, "src/engine.py"), "# engine\ndef evaluate_batch(x):\n    return calibrate(x)\n# evaluate_batch_extra\n# EVALUATE_BATCH\n");
  writeFileSync(join(source, "src/adapter.py"), "# adapter\ndef calibrate(x):\n    return x\n");
  writeFileSync(join(source, "src[legacy]/engine.py"), "evaluate_batch\n");
  writeFileSync(join(source, "src/long.py"), longLines.join("\n") + "\n");
  writeFileSync(join(source, "src/dense.py"), denseLines.join("\n") + "\n");
  writeFileSync(join(source, "empty.txt"), "");
  writeFileSync(join(source, "binary.bin"), Buffer.from([0, 1, 2]));
  execFileSync("git", ["-C", source, "init", "-b", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-m", "Code reading fixture"], { stdio: "pipe" });
  repository = await repos.attachRepository(project.id, { source, ref: "main" });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("code reading through the agent tool interface", () => {
  it("accepts the exact formerly failing 220-line request with an irrelevant limit", async () => {
    const result = await inspect("read", { path: "src/long.py", startLine: 1, endLine: 220, offset: 99, limit: 220 });
    expect(result.content.split("\n")).toEqual(longLines.slice(0, 220));
    expect(result).toMatchObject({ startLine: 1, endLine: 220, nextLine: 221 });
  });
  it("reads large ranges without skipped or duplicated lines and keeps strict claim evidence limits", async () => {
    const lines: string[] = [];
    let startLine: number | null = 1;
    do {
      const result = await inspect("read", { path: "src/long.py", startLine, endLine: 901 });
      expect(result.endLine - result.startLine + 1).toBeLessThanOrEqual(400);
      lines.push(...result.content.split("\n")); startLine = result.nextLine;
    } while (startLine !== null);
    expect(lines).toEqual(longLines);
    await expect(repos.readRepositoryFile(ctx.project.id, args("read", { path: "src/long.py", startLine: 1, endLine: 901 }))).rejects.toThrow("400 lines");
  });
  it("automatically pages character-heavy source while preserving exact content", async () => {
    const lines: string[] = [];
    let startLine: number | null = 1;
    do {
      const result = await inspect("read", { path: "src/dense.py", startLine, endLine: 150 });
      expect(JSON.stringify(result).length).toBeLessThan(45_000);
      lines.push(...result.content.split("\n")); startLine = result.nextLine;
    } while (startLine !== null);
    expect(lines).toEqual(denseLines);
  });
  it("finds filenames and searches symbol definitions with regex and source context", async () => {
    expect((await inspect("files", { query: "ADAPTER" })).files.map((f: any) => f.path)).toEqual(["src/adapter.py"]);
    const result = await inspect("search", { query: "^def (evaluate_batch|calibrate)\\(", searchMode: "regex", path: "src/", contextLines: 1, limit: 1 });
    expect(result.total).toBe(2); expect(result.nextOffset).toBe(1);
    expect(result.matches[0]).toMatchObject({ path: "src/adapter.py", line: 2,
      context: { startLine: 1, endLine: 3, content: "# adapter\ndef calibrate(x):\n    return x", commit: repository.commit } });
    const next = await inspect("search", { query: "^def (evaluate_batch|calibrate)\\(", searchMode: "regex", path: "src/", offset: result.nextOffset });
    expect(next.matches[0].path).toBe("src/engine.py"); expect(next.nextOffset).toBeNull();
  });
  it("supports literal, case-sensitive and whole-identifier searches and literal path prefixes", async () => {
    expect((await inspect("search", { query: "evaluate_batch", path: "src/", caseSensitive: true, wholeWord: true })).matches.map((m: any) => m.line)).toEqual([2]);
    expect((await inspect("search", { query: "evaluate_batch", path: "src/", wholeWord: true })).matches.map((m: any) => m.line)).toEqual([2, 5]);
    expect((await inspect("search", { query: "evaluate_batch", path: "src[legacy]/" })).matches.map((m: any) => m.path)).toEqual(["src[legacy]/engine.py"]);
    expect((await inspect("search", { query: "return calibrate(x)", path: "src/" })).total).toBe(1);
    expect((await inspect("search", { query: "does_not_exist", searchMode: "regex" })).total).toBe(0);
  });
  it("reads related files together and retains successful excerpts when another file fails", async () => {
    const result = await inspect("read_many", { reads: [{ path: "src/engine.py" }, { path: "missing.py" }, { path: "binary.bin" }, { path: "src/adapter.py" }] });
    expect(result.results[0].content).toContain("evaluate_batch");
    expect(result.results[1].error).toContain("not found");
    expect(result.results[2].error).toContain("Binary");
    expect(result.results[3].content).toContain("calibrate");
    expect(result.nextOffset).toBeNull();
  });
  it("bounds batch responses and resumes at the next unread request", async () => {
    const reads = Array.from({ length: 4 }, (_, i) => ({ path: "src/dense.py", startLine: i + 1, endLine: 150 }));
    let offset: number | null = 0;
    const starts: number[] = [];
    do {
      const result = await inspect("read_many", { reads, offset });
      expect(JSON.stringify(result).length).toBeLessThan(85_000);
      starts.push(...result.results.map((r: any) => r.startLine)); offset = result.nextOffset;
    } while (offset !== null);
    expect(starts).toEqual([1, 2, 3, 4]);
  });
  it("pages context-heavy searches without losing matches", async () => {
    let offset: number | null = 0;
    const lines: number[] = [];
    do {
      const result = await inspect("search", { query: ":", path: "src/dense.py", contextLines: 10, offset });
      expect(JSON.stringify(result).length).toBeLessThan(85_000);
      lines.push(...result.matches.map((m: any) => m.line)); offset = result.nextOffset;
    } while (offset !== null);
    expect(lines).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
  });
  it("gives actionable errors while preserving pagination and range validation", async () => {
    const failure = await executeTool(ctx, "inspect_repository", args("files", { limit: 220 }));
    expect(failure.isError).toBe(true);
    expect(failure.content).toContain("limit: For files, request at most 200 items per page and follow nextOffset.");
    expect(failure.content).not.toContain('"code"');
    const regex = await executeTool(ctx, "inspect_repository", args("search", { query: "[", searchMode: "regex" }));
    expect(regex.isError).toBe(true); expect(regex.content).toContain("POSIX extended regex syntax");
    const range = await executeTool(ctx, "inspect_repository", args("read", { path: "src/long.py", startLine: 20, endLine: 10 }));
    expect(range.isError).toBe(true); expect(range.content).toContain("precedes");
    expect((await inspect("read", { path: "empty.txt", limit: 220 })).content).toBe("");
  });
  it("publishes the same usable reading contract to all backends", async () => {
    const { RESEARCH_TOOLS } = await import("../src/research/tools.js");
    const { toolDefinitions } = await import("../src/backends/openai.js");
    const { codexTools } = await import("../src/backends/codex.js");
    const shared = RESEARCH_TOOLS.find(t => t.name === "inspect_repository")!;
    expect(shared.schema.parse(args("read", { limit: 220 }))).toMatchObject({ limit: 220 });
    for (const schema of [toolDefinitions(true).find(t => t.function.name === shared.name)!.function.parameters,
      codexTools().find(t => t.name === shared.name)!.inputSchema] as any[]) {
      expect(schema.properties.limit.maximum ?? Infinity).toBeGreaterThan(220);
      expect(schema.properties.limit.description).toContain("Ignored for read/list");
      expect(schema.properties.action.enum).toContain("read_many");
      expect(schema.properties.searchMode.enum).toContain("regex");
    }
  });
});
