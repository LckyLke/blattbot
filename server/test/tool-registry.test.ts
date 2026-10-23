/**
 * The shared tool registry (backends/tools.ts): one definition per tool, and
 * every backend's catalog derived from it.
 */
import { describe, expect, it } from "vitest";
import { PROJECT_TOOLS, AGENT_TOOL_INFO, eventToolName, executeTool, summarizeToolInput } from "../src/backends/tools.js";
import { toolDefinitions, OPENAI_TOOL_INFO } from "../src/backends/openai.js";
import { buildMcpServer } from "../src/backends/claude.js";
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
    const server: any = buildMcpServer(ctx);
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
