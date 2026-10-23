/**
 * search_files: the shared text-search tool every backend gets. Covers the
 * search options, the result cap and context output, and the read_file path
 * fence (no .git, no symlink escape, nothing outside the project and its
 * attached context), plus its wiring into each backend's catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string, dir: string, context: string, outside: string;
let tools: typeof import("../src/backends/tools.js");
let ctx: any;
const search = async (args: Record<string, unknown>) => tools.executeTool(ctx, "search_files", args);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "search-files-"));
  dir = join(root, "data", "projects", "p1");
  context = join(root, "context");
  outside = join(root, "outside");
  for (const d of [join(dir, "sections"), join(dir, ".git"), context, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello Transformer world.\n\\input{sections/intro}\n\\end{document}\n");
  writeFileSync(join(dir, "sections", "intro.tex"), ["one", "two", "attention is all you need", "four", "five", "six", "Attention again", "eight"].join("\n"));
  writeFileSync(join(dir, "sections2.tex"), "attention in a sibling file\n");
  writeFileSync(join(dir, ".git", "config"), "[remote] url = https://token:attention@example.com\n");
  writeFileSync(join(dir, "figure.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0x61, 0x74]));
  writeFileSync(join(context, "notes.md"), "context attention note\n");
  writeFileSync(join(outside, "secret.tex"), "attention outside the project\n");
  vi.stubEnv("BLATTBOT_DATA_DIR", join(root, "data"));
  vi.resetModules();
  tools = await import("../src/backends/tools.js");
  ctx = { project: { id: "p1" }, dir, contextDirs: [context], readOnly: true, signal: new AbortController().signal, emit: vi.fn() };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("search_files", () => {
  it("finds literal text case-insensitively across project files, in grep's path:line:text shape", async () => {
    const out = await search({ query: "ATTENTION" });
    expect(out.isError).toBe(false);
    expect(out.content).toContain("3 matching lines");
    expect(out.content).toContain("sections/intro.tex:3:attention is all you need");
    expect(out.content).toContain("sections/intro.tex:7:Attention again");
    expect(out.content).toContain("sections2.tex:1:attention in a sibling file");
    // Literal mode: regex metacharacters are plain text.
    expect((await search({ query: "\\input{" })).content).toContain("main.tex:4:\\input{sections/intro}");
    expect((await search({ query: "a.tention" })).content).toMatch(/^No matches/);
  });

  it("honours caseSensitive, regex mode and invalid regular expressions", async () => {
    const exact = await search({ query: "Attention", caseSensitive: true });
    expect(exact.content).toContain("1 matching line ");
    expect(exact.content).toContain("sections/intro.tex:7:");
    const re = await search({ query: "^atten\\w+ (is|again)", regex: true });
    expect(re.content).toContain("2 matching lines");
    const bad = await search({ query: "(unclosed", regex: true });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/^search_files failed: invalid regular expression/);
  });

  it("restricts the search to a path prefix: a directory, a file, or the start of a name", async () => {
    const inDir = await search({ query: "attention", path: "sections/" });
    expect(inDir.content).toContain("2 matching lines");
    expect(inDir.content).not.toContain("sections2.tex");
    const prefix = await search({ query: "attention", path: "sections" });
    expect(prefix.content).toContain("3 matching lines");
    const file = await search({ query: "attention", path: "sections2.tex" });
    expect(file.content).toContain("1 matching line ");
    expect(file.content).toContain("across 1 searched file:");
  });

  it("adds context lines, merges overlapping excerpts and separates distant ones", async () => {
    const out = await search({ query: "attention", path: "sections/intro.tex", contextLines: 1 });
    expect(out.content).toContain(["sections/intro.tex-2-two", "sections/intro.tex:3:attention is all you need", "sections/intro.tex-4-four", "--", "sections/intro.tex-6-six"].join("\n"));
    const merged = await search({ query: "attention", path: "sections/intro.tex", contextLines: 3 });
    expect(merged.content).not.toContain("--");
    expect(merged.content.match(/intro\.tex-5-five/g)).toHaveLength(1);
  });

  it("caps the results at limit and says how to see more", async () => {
    writeFileSync(join(dir, "many.tex"), Array.from({ length: 30 }, (_, i) => `needle ${i}`).join("\n"));
    const out = await search({ query: "needle", limit: 5 });
    expect(out.content).toContain("30 matching lines");
    expect(out.content.match(/^many\.tex:\d+:/gm)).toHaveLength(5);
    expect(out.content).toContain("Showing the first 5; narrow query or path, or raise limit (max 200).");
    const invalid = await search({ query: "needle", limit: 500 });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toMatch(/limit:/);
  });

  it("never searches .git, binaries or symlinks, and refuses paths outside the read fence", async () => {
    symlinkSync(join(outside, "secret.tex"), join(dir, "linked.tex"));
    symlinkSync(outside, join(dir, "linked-dir"));
    const all = await search({ query: "attention" });
    expect(all.content).not.toContain(".git");
    expect(all.content).not.toContain("example.com");
    expect(all.content).not.toContain("outside the project");
    expect(all.content).toContain("Skipped 1 binary file");
    for (const [path, message] of [
      [".git", /off-limits/],
      [".git/config", /off-limits/],
      ["linked.tex", /symbolic links/],
      ["linked-dir/", /symbolic links/],
      ["../../../outside", /invalid path/],
      [outside, /outside the project/],
    ] as const) {
      const out = await search({ query: "attention", path });
      expect(out.isError, path).toBe(true);
      expect(out.content, path).toMatch(message);
    }
  });

  it("searches an attached context directory by absolute path", async () => {
    const out = await search({ query: "attention", path: context });
    expect(out.isError).toBe(false);
    expect(out.content).toContain(`${join(context, "notes.md")}:1:context attention note`);
    // Without a path, only the project itself is searched.
    expect((await search({ query: "context attention" })).content).toMatch(/^No matches/);
  });

  it("stops a runaway regular expression with an error instead of hanging", async () => {
    const { searchFiles } = await import("../src/backends/search-files.js");
    writeFileSync(join(dir, "slow.tex"), "a".repeat(40) + "\n");
    expect(() => searchFiles(dir, [], { query: "(a+)+b", regex: true }, { maxFileBytes: 1 << 20, timeoutMs: 100 }))
      .toThrow(/timed out/);
  });

  it("is served to every backend, in read-only modes too, under one event name", async () => {
    const { toolDefinitions } = await import("../src/backends/openai.js");
    const { codexTools } = await import("../src/backends/codex.js");
    const { buildMcpServer } = await import("../src/backends/claude.js");
    expect(toolDefinitions(true).some((t) => t.function.name === "search_files")).toBe(true);
    expect(codexTools().some((t) => t.name === "search_files")).toBe(true);
    const server: any = buildMcpServer(ctx);
    const listed = await server.instance.server._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    const claude = listed.tools.find((t: any) => t.name === "search_files");
    expect(claude.inputSchema.required).toEqual(["query"]);
    expect(claude.inputSchema.properties.path.description).toMatch(/path prefix/);
    expect(tools.eventToolName("search_files")).toBe("mcp__blattbot__search_files");
    expect(tools.summarizeToolInput("mcp__blattbot__search_files", { query: "needle", path: "sections" }, dir)).toBe("needle in sections");
  });
});
