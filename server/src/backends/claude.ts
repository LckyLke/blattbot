/**
 * Claude Agent SDK backend — the original BlattBot agent, moved verbatim from
 * agent.ts. Spawns the Claude Code CLI via the Agent SDK (reusing the local
 * login unless an API key is configured), exposes the four BlattBot tools as
 * an SDK MCP server, and maps the SDK's stream onto the shared event contract.
 */
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getProject, projectDir, updateProject } from "../config.js";
import { compileProject } from "../compile.js";
import { addCitation, readAllBibEntries, searchPapers } from "../citations.js";
import { loadSettings } from "../settings.js";
import {
  AGENT_TOOL_INFO,
  DISALLOWED_TOOLS,
  resolveModel,
  type AgentBackend,
  type BackendTurnContext,
} from "./types.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function buildMcpServer(projectId: string) {
  const dir = projectDir(projectId);

  const compileTool = tool(
    "compile_latex",
    AGENT_TOOL_INFO[0].description,
    {},
    async () => {
      const project = getProject(projectId);
      const result = await compileProject(projectId, dir, project?.mainTex);
      if (result.ok) {
        return text(`Compilation succeeded with ${result.engine} in ${result.durationMs}ms (main file: ${result.mainTex}).`);
      }
      return text(
        `Compilation FAILED (engine: ${result.engine}, main file: ${result.mainTex || "not found"}).\n` +
          `Errors:\n${result.errors.join("\n---\n")}\n\nLog tail:\n${result.logTail.slice(-2000)}`,
      );
    },
  );

  const searchTool = tool(
    "search_papers",
    AGENT_TOOL_INFO[1].description,
    {
      query: z.string().describe("Free-text search, e.g. 'attention is all you need transformer'"),
      limit: z.number().int().min(1).max(15).optional().describe("Max results, default 5"),
    },
    async ({ query: q, limit }) => {
      try {
        const hits = await searchPapers(q, limit ?? 5);
        if (hits.length === 0) return text("No results found — try different phrasing or author names.");
        const lines = hits.map(
          (h, i) =>
            `${i + 1}. ${h.title} — ${h.authors}${h.year ? ` (${h.year})` : ""}${h.venue ? `, ${h.venue}` : ""}` +
            `${h.citations != null ? ` [${h.citations} citations]` : ""}\n   cite-ref: ${h.ref}  (via ${h.source})`,
        );
        return text(lines.join("\n"));
      } catch (err: any) {
        return text(`Search failed: ${err?.message ?? err}`);
      }
    },
  );

  const addCitationTool = tool(
    "add_citation",
    AGENT_TOOL_INFO[2].description,
    {
      ref: z
        .string()
        .describe("A DOI (e.g. 10.1038/nature14539), or dblp:<key> / arxiv:<id> exactly as returned by search_papers"),
      bibFile: z.string().optional().describe("Relative path of the .bib file to append to; defaults to the project's existing .bib"),
    },
    async ({ ref, bibFile }) => {
      try {
        const result = await addCitation(dir, ref, bibFile);
        if (result.status === "duplicate") {
          return text(`Already in bibliography as \\cite{${result.key}} (${result.bibFile}). Do not add it again.`);
        }
        return text(`Added to ${result.bibFile} as \\cite{${result.key}}.\n${result.entryPreview ?? ""}`);
      } catch (err: any) {
        return text(`add_citation failed: ${err?.message ?? err}`);
      }
    },
  );

  const listCitationsTool = tool(
    "list_citations",
    AGENT_TOOL_INFO[3].description,
    {},
    async () => {
      const all = readAllBibEntries(dir);
      if (all.length === 0) return text("The project has no .bib entries yet.");
      const lines = all.map(
        ({ file, entry }) =>
          `\\cite{${entry.key}} — ${entry.fields.title ?? "(no title)"}${entry.fields.year ? ` (${entry.fields.year})` : ""} [${file}]`,
      );
      return text(lines.join("\n"));
    },
  );

  return createSdkMcpServer({
    name: "blattbot",
    version: "0.1.0",
    tools: [compileTool, searchTool, addCitationTool, listCitationsTool],
  });
}

/** Extract a compact, UI-friendly summary of a tool input. */
function summarizeInput(name: string, input: any, projectRoot?: string): string {
  if (input == null) return "";
  try {
    if (typeof input.file_path === "string") {
      if (projectRoot && input.file_path.startsWith(projectRoot)) {
        return input.file_path.slice(projectRoot.length).replace(/^\//, "");
      }
      return input.file_path.split("/").slice(-2).join("/");
    }
    if (typeof input.command === "string") return input.command.length > 80 ? input.command.slice(0, 77) + "…" : input.command;
    if (typeof input.query === "string") return input.query;
    if (typeof input.doi === "string") return input.doi;
    if (typeof input.pattern === "string") return input.pattern;
    const s = JSON.stringify(input);
    return s.length > 80 ? s.slice(0, 77) + "…" : s;
  } catch {
    return "";
  }
}

export const claudeBackend: AgentBackend = {
  id: "claude",
  label: "Claude Code (Agent SDK)",
  description:
    "Claude Agent SDK running locally — reuses your Claude Code CLI login unless an API key is set.",

  async runTurn(ctx: BackendTurnContext): Promise<void> {
    const { project, dir, settings, contextDirs } = ctx;
    const disallowed = [
      ...(ctx.readOnly
        ? [...DISALLOWED_TOOLS, "Edit", "Write", "MultiEdit", "NotebookEdit", "mcp__blattbot__add_citation"]
        : DISALLOWED_TOOLS),
      // Hard-block edits inside context dirs (path-scoped permission rules).
      ...contextDirs.flatMap((d) => [
        `Edit(${d}/**)`,
        `Write(${d}/**)`,
        `MultiEdit(${d}/**)`,
        `NotebookEdit(${d}/**)`,
      ]),
    ];

    // Session ids of the openai backend (oai-…) mean nothing to the SDK —
    // switching backends mid-chat starts a fresh SDK session instead of
    // failing on an unknown resume id.
    const raw = ctx.session.sessionId;
    const resumeId = raw && !raw.startsWith("oai-") ? raw : undefined;

    // The SDK wants an AbortController of its own; relay the dispatcher's signal.
    const controller = new AbortController();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const q = query({
      prompt: ctx.prompt,
      options: {
        cwd: dir,
        ...(contextDirs.length > 0 ? { additionalDirectories: contextDirs } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
        model: ctx.model,
        env: {
          ...process.env,
          ...(settings.apiKey ? { ANTHROPIC_API_KEY: settings.apiKey } : {}),
          ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController: controller,
        systemPrompt: { type: "preset", preset: "claude_code", append: ctx.systemAppend },
        mcpServers: { blattbot: buildMcpServer(project.id) },
        disallowedTools: disallowed,
        settingSources: [],
      },
    });

    // Emit "thinking" once per thinking block, not once per streamed token.
    let thinkingNotified = false;

    for await (const m of q as AsyncIterable<any>) {
      switch (m.type) {
        case "system": {
          if (m.subtype === "init" && m.session_id && m.session_id !== resumeId) {
            // Keep the legacy per-project field in sync (harmless; aids rollback) —
            // the caller persists the id on the active chat via onSessionId.
            updateProject(project.id, { sessionId: m.session_id });
            project.sessionId = m.session_id;
            ctx.session.onSessionId?.(m.session_id);
          }
          break;
        }
        case "stream_event": {
          const ev = m.event;
          if (ev?.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta" && ev.delta.text) {
              thinkingNotified = false;
              ctx.emit({ type: "text_delta", text: ev.delta.text });
            } else if (ev.delta?.type === "thinking_delta" && !thinkingNotified) {
              thinkingNotified = true;
              ctx.emit({ type: "thinking" });
            }
          } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
            ctx.emit({
              type: "tool_start",
              name: ev.content_block.name,
            });
          }
          break;
        }
        case "assistant": {
          const blocks = m.message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              ctx.emit({ type: "text_final", text: block.text });
            } else if (block.type === "tool_use") {
              ctx.emit({
                type: "tool_use",
                id: block.id,
                name: block.name,
                detail: summarizeInput(block.name, block.input, dir),
              });
            }
          }
          break;
        }
        case "user": {
          const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_result") {
              ctx.emit({
                type: "tool_result",
                id: block.tool_use_id,
                isError: Boolean(block.is_error),
              });
            }
          }
          break;
        }
        case "result": {
          ctx.emit({
            type: "turn_end",
            isError: Boolean(m.is_error),
            costUsd: m.total_cost_usd,
            durationMs: m.duration_ms,
            result: typeof m.result === "string" ? m.result : undefined,
          });
          break;
        }
        default:
          break;
      }
    }
  },
};

/**
 * One-shot, tool-less model call → the final text. Used for tiny generation
 * tasks like condensing a paper abstract into a TL;DR. Shares the agent's
 * model/key/base-URL settings but never touches files or sessions.
 * (Always runs on the Claude SDK, regardless of the configured turn backend.)
 */
export async function runOneShot(prompt: string): Promise<string> {
  const settings = loadSettings();
  const q = query({
    prompt,
    options: {
      maxTurns: 1,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      settingSources: [],
      model: resolveModel(settings.model),
      env: {
        ...process.env,
        ...(settings.apiKey ? { ANTHROPIC_API_KEY: settings.apiKey } : {}),
        ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
      },
    },
  });
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "result") {
      if (!m.is_error && typeof m.result === "string" && m.result.trim()) return m.result.trim();
      throw new Error(`one-shot agent call failed${typeof m.result === "string" ? `: ${m.result}` : ""}`);
    }
  }
  throw new Error("one-shot agent call returned no result");
}
