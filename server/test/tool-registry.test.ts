/**
 * The shared tool registry (backends/tools.ts): one definition per tool, and
 * every backend's catalog derived from it.
 */
import { describe, expect, it } from "vitest";
import { PROJECT_TOOLS, AGENT_TOOL_INFO, eventToolName, executeTool, modeTools, summarizeToolInput } from "../src/backends/tools.js";
import { toolDefinitions, OPENAI_TOOL_INFO } from "../src/backends/openai.js";
import { buildMcpServer } from "../src/backends/claude.js";
import { codexTools } from "../src/backends/codex.js";
import { AGENT_MODES, buildSystemAppend } from "../src/agent.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { RESEARCH_TOOLS } from "../src/research/tools.js";

const ctx: any = { project: { id: "registry" }, dir: "/tmp/registry-project", contextDirs: [], readOnly: true, signal: new AbortController().signal, emit() {} };

describe("shared tool registry", () => {
  it("defines each tool once and derives every catalog from it", async () => {
    const names = PROJECT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(toolDefinitions(false).map((t) => t.function.name)).toEqual(names);
    expect(OPENAI_TOOL_INFO.map((t) => t.name)).toEqual(names);
    // Read-only catalogs lose exactly the writing tools.
    expect(names.filter((n) => !toolDefinitions(true).some((t) => t.function.name === n)).sort())
      .toEqual(["add_citation", "edit_file", "write_file"]);
    // Claude gets everything without a native Claude Code twin.
    const server: any = await buildMcpServer(ctx);
    const listed = await server.instance.server._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    expect(listed.tools.map((t: any) => t.name).sort()).toEqual(PROJECT_TOOLS.filter((t) => t.claude).map((t) => t.name).sort());
    expect(PROJECT_TOOLS.filter((t) => !t.claude).map((t) => t.name).sort()).toEqual(["ask_user", "edit_file", "list_files", "read_file", "write_file"]);
    for (const tool of listed.tools) {
      expect(tool.description).toBe(PROJECT_TOOLS.find((t) => t.name === tool.name)!.description);
    }
    expect(AGENT_TOOL_INFO.map((t) => t.name).sort()).toEqual(
      PROJECT_TOOLS.filter((t) => t.claude && !RESEARCH_TOOLS.some((r) => r.name === t.name)).map((t) => t.name).sort(),
    );
    expect(AGENT_TOOL_INFO.map((t) => t.name)).toContain("search_files");
  });

  it("trims the Polish catalog for Claude and the OpenAI-compatible backend, never Codex's", async () => {
    const polish = modeTools("polish").map((t) => t.name);
    expect(polish).toEqual(["read_url", "list_files", "search_files", "read_file", "write_file", "edit_file", "ask_user", "compile_latex", "list_citations"]);
    for (const mode of ["edit", "research", "review", "understand", "code", undefined]) {
      expect(modeTools(mode)).toBe(PROJECT_TOOLS);
    }
    const server: any = await buildMcpServer({ ...ctx, mode: "polish" });
    const listed = await server.instance.server._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    expect(listed.tools.map((t: any) => t.name).sort()).toEqual(["compile_latex", "list_citations", "read_url", "search_files"]);
    expect(codexTools().map((t) => t.name)).toEqual(PROJECT_TOOLS.map((t) => t.name));
    // The lean prompt names none of the tools the mode leaves out.
    expect(buildSystemAppend({ id: "p", name: "p", gitUrl: "", createdAt: "" } as any, AGENT_MODES.find((m) => m.id === "polish")!, undefined, { ...DEFAULT_SETTINGS }, []))
      .not.toMatch(/search_papers|add_citation|verify_citation_support|read_paper/);
  });

  it("maps every tool to one event name", () => {
    expect(eventToolName("read_file")).toBe("Read");
    expect(eventToolName("ask_user")).toBe("AskUserQuestion");
    expect(eventToolName("list_files")).toBe("list_files");
    expect(eventToolName("inspect_repository")).toBe("mcp__blattbot__inspect_repository");
  });

  it("refuses unknown tools and writing tools in read-only modes", async () => {
    expect(await executeTool(ctx, "nope", {})).toEqual({ content: "unknown tool: nope", isError: true });
    expect(await executeTool(ctx, "add_citation", { ref: "10.1/x" })).toEqual({
      content: "add_citation failed: adding citations is disabled in this read-only mode", isError: true,
    });
  });

  it("summarizes native Claude Code inputs and BlattBot tool inputs with one function", () => {
    const dir = "/tmp/registry-project";
    expect(summarizeToolInput("Read", { file_path: `${dir}/sections/intro.tex` }, dir)).toBe("sections/intro.tex");
    expect(summarizeToolInput("Read", { file_path: "/elsewhere/a/b/c.tex" }, dir)).toBe("b/c.tex");
    expect(summarizeToolInput("Grep", { pattern: "\\cite", path: dir }, dir)).toBe("\\cite");
    expect(summarizeToolInput("Bash", { command: "x".repeat(100) }, dir)).toBe("x".repeat(77) + "…");
    expect(summarizeToolInput("read_file", { path: "main.tex" }, dir)).toBe("main.tex");
    expect(summarizeToolInput("mcp__blattbot__add_citation", { ref: "10.1/x" }, dir)).toBe("10.1/x");
    expect(summarizeToolInput("search_papers", { query: "transformers" }, dir)).toBe("transformers");
    expect(summarizeToolInput("ask_user", { questions: [{ question: "Which one?" }] }, dir)).toBe("Which one?");
    expect(summarizeToolInput("mcp__blattbot__compile_latex", {}, dir)).toBe("");
  });
});
