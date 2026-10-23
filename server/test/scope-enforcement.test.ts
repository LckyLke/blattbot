// A turn the user scoped to some files may write only those — on every
// backend: BlattBot's own tools (OpenAI-compatible and Codex) through
// resolveWritePath, Claude's native Write/Edit through the fence hook and the
// permission callback. Reads stay unrestricted.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendTurnContext } from "../src/backends/types.js";

let data: string;
let dir: string;
let ctx: BackendTurnContext;
let tools: typeof import("../src/backends/tools.js");
let paths: typeof import("../src/backends/paths.js");
let claude: typeof import("../src/backends/claude.js");

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "blattbot-scope-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", data);
  vi.resetModules();
  const config = await import("../src/config.js");
  const { DEFAULT_SETTINGS } = await import("../src/settings.js");
  tools = await import("../src/backends/tools.js");
  paths = await import("../src/backends/paths.js");
  claude = await import("../src/backends/claude.js");
  const project = config.addProject({ name: "Scoped", gitUrl: "local", kind: "local" });
  dir = config.projectDir(project.id);
  mkdirSync(join(dir, "sections"), { recursive: true });
  writeFileSync(join(dir, "main.tex"), "main text\n");
  writeFileSync(join(dir, "sections", "intro.tex"), "intro text\n");
  writeFileSync(join(dir, "refs.bib"), "");
  ctx = {
    project, dir, prompt: "", systemAppend: "", model: "", readOnly: false, contextDirs: [], attachments: [],
    settings: { ...DEFAULT_SETTINGS }, session: {}, signal: new AbortController().signal, emit: () => {},
    scope: ["sections/intro.tex"],
  };
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(data, { recursive: true, force: true, maxRetries: 10 });
});

describe("BlattBot's write tools (OpenAI-compatible and Codex backends)", () => {
  it("write the scoped files and refuse every other one", async () => {
    const outside = await tools.executeTool(ctx, "write_file", { path: "main.tex", content: "overwritten" });
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/main\.tex is outside this turn's scope — the user limited edits to sections\/intro\.tex/);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe("main text\n");

    const created = await tools.executeTool(ctx, "write_file", { path: "new.tex", content: "x" });
    expect(created.isError).toBe(true);
    expect(existsSync(join(dir, "new.tex"))).toBe(false);

    const edit = await tools.executeTool(ctx, "edit_file", { path: "main.tex", old_string: "main", new_string: "MAIN" });
    expect(edit.isError).toBe(true);

    const inside = await tools.executeTool(ctx, "edit_file", { path: "./sections/intro.tex", old_string: "intro", new_string: "INTRO" });
    expect(inside).toMatchObject({ isError: false });
    expect(readFileSync(join(dir, "sections", "intro.tex"), "utf8")).toBe("INTRO text\n");
  });

  it("refuse a citation into a bibliography outside the scope, before any lookup", async () => {
    const out = await tools.executeTool(ctx, "add_citation", { ref: "10.1000/example" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/refs\.bib is outside this turn's scope/);
  });

  it("keep reads unrestricted", async () => {
    const read = await tools.executeTool(ctx, "read_file", { path: "main.tex" });
    expect(read).toMatchObject({ isError: false });
    expect(read.content).toContain("main text");
  });

  it("are unrestricted without a scope", () => {
    expect(paths.resolveWritePath(dir, [], "main.tex")).toBe(join(dir, "main.tex"));
    expect(paths.resolveWritePath(dir, [], "main.tex", [])).toBe(join(dir, "main.tex"));
    expect(() => paths.resolveWritePath(dir, [], "main.tex", ["sections/intro.tex"])).toThrow(/outside this turn's scope/);
  });
});

describe("Claude's native file tools", () => {
  const hookInput = (tool_name: string, tool_input: Record<string, unknown>) =>
    ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s", transcript_path: "/dev/null", cwd: dir }) as any;

  it("are denied outside the scope by the PreToolUse fence", async () => {
    const hook = claude.makeFenceHook(ctx.project.id, [], false, ctx.scope);
    for (const [tool, input] of [
      ["Write", { file_path: join(dir, "main.tex"), content: "x" }],
      ["Edit", { file_path: "main.tex", old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: join(dir, "other.tex"), edits: [] }],
      ["NotebookEdit", { notebook_path: join(dir, "nb.ipynb"), new_source: "" }],
    ] as const) {
      const out = (await hook(hookInput(tool, input), "t", { signal: new AbortController().signal })) as any;
      expect(out.hookSpecificOutput?.permissionDecision, tool).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/outside this turn's scope/);
    }
    const allowed = await hook(hookInput("Edit", { file_path: join(dir, "sections", "intro.tex"), old_string: "a", new_string: "b" }), "t", {
      signal: new AbortController().signal,
    });
    expect(allowed).toEqual({});
    expect(await hook(hookInput("Read", { file_path: join(dir, "main.tex") }), "t", { signal: new AbortController().signal })).toEqual({});
  });

  it("are denied outside the scope by the permission callback too", async () => {
    const canUse = claude.makeCanUseTool(ctx.project.id, () => {}, new AbortController().signal, [], ctx.scope);
    const opts = { signal: new AbortController().signal } as any;
    expect(await canUse("Write", { file_path: join(dir, "main.tex"), content: "x" }, opts)).toMatchObject({ behavior: "deny" });
    expect(await canUse("Write", { file_path: join(dir, "sections", "intro.tex"), content: "x" }, opts)).toMatchObject({ behavior: "allow" });
    expect(await canUse("Grep", { pattern: "x", path: dir }, opts)).toMatchObject({ behavior: "allow" });
  });
});
