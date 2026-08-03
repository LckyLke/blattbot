/**
 * Claude Agent SDK backend — the original BlattBot agent, moved verbatim from
 * agent.ts. Spawns the Claude Code CLI via the Agent SDK (reusing the local
 * login unless an API key is configured), exposes the four BlattBot tools as
 * an SDK MCP server, and maps the SDK's stream onto the shared event contract.
 */
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getProject, projectDir, updateProject } from "../config.js";
import { attachmentBase64, chatUploadsDir, type TurnAttachment } from "../chatimages.js";
import { compileProject } from "../compile.js";
import { addCitation, formatAddCitationResult, readAllBibEntries, searchPapers } from "../citations.js";
import {
  auditEntries,
  formatAuditReport,
  formatCitationCheckResult,
  verifyCitationSupport,
  verifyEntry,
} from "../papers.js";
import { checkToolPaths, projectReadRoots, secretDenyRules } from "./paths.js";
import { loadSettings } from "../settings.js";
import { askUserQuestions, validateQuestions, type AgentQuestion } from "../questions.js";
import {
  AGENT_TOOL_INFO,
  DISALLOWED_TOOLS,
  resolveModel,
  resultHead,
  type AgentBackend,
  type BackendTurnContext,
  type EventSink,
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
        // Verify immediately: a bad reference must surface while the agent is
        // still in the turn that added it, not at review time.
        const verification =
          result.status === "added" ? await verifyEntry(projectId, dir, result.key) : undefined;
        return text(formatAddCitationResult(result, verification));
      } catch (err: any) {
        return text(`add_citation failed: ${err?.message ?? err}`);
      }
    },
  );

  const auditCitationsTool = tool(
    "audit_citations",
    AGENT_TOOL_INFO[4].description,
    {
      keys: z
        .array(z.string())
        .optional()
        .describe("Cite keys to verify; omit to verify every entry in the bibliography"),
    },
    async ({ keys }) => {
      try {
        const { results, unknownKeys } = await auditEntries(projectId, dir, keys);
        return text(formatAuditReport(results, unknownKeys));
      } catch (err: any) {
        return text(`audit_citations failed: ${err?.message ?? err}`);
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

  const verifyCitationTool = tool(
    "verify_citation_support",
    AGENT_TOOL_INFO[5].description,
    {
      key: z.string().describe("The cite key (as used in \\cite{...}) of the reference to check"),
      claim: z.string().describe("The specific statement or sentence the citation is attached to, verbatim"),
    },
    async ({ key, claim }) => {
      try {
        const result = await verifyCitationSupport(projectId, dir, key, claim);
        return text(formatCitationCheckResult(key, claim, result));
      } catch (err: any) {
        return text(`verify_citation_support failed: ${err?.message ?? err}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "blattbot",
    version: "0.1.0",
    tools: [compileTool, searchTool, addCitationTool, listCitationsTool, auditCitationsTool, verifyCitationTool],
  });
}

/**
 * Cost/token usage from the SDK's final result message. total_cost_usd is the
 * turn's dollar cost; usage carries the token counts — input tokens are the
 * sum of fresh input plus cache creation/reads, so the number reflects what
 * the model actually consumed. Absent/malformed fields simply stay undefined.
 */
export function extractResultUsage(m: any): {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
} {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const usage = m?.usage ?? {};
  const input = num(usage.input_tokens);
  const cacheCreate = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const inputTokens =
    input === undefined && cacheCreate === undefined && cacheRead === undefined
      ? undefined
      : (input ?? 0) + (cacheCreate ?? 0) + (cacheRead ?? 0);
  return {
    costUsd: num(m?.total_cost_usd),
    inputTokens,
    outputTokens: num(usage.output_tokens),
  };
}

/**
 * The SDK's permission callback, wired for AskUserQuestion. Everything else is
 * a pure passthrough allow: the query runs with permissionMode
 * "bypassPermissions", under which the CLI auto-allows every ordinary tool
 * internally and never consults this callback for them — verified against the
 * bundled cli.js, whose permission pipeline returns AskUserQuestion's "ask"
 * (checkPermissions always asks + requiresUserInteraction) BEFORE the
 * bypass-mode auto-allow, so the ask reaches this callback even in bypass
 * mode. The passthrough arm is belt-and-braces for any other tool a future
 * SDK routes here; it preserves bypass-equivalent permissiveness
 * (read-only-mode/edit blocking stays enforced via disallowedTools).
 *
 * On AskUserQuestion: validate the questions, register them as the project's
 * pending question, stream a `question` event to the UI, and block until the
 * user answers (→ allow with the answers echoed into updatedInput), dismisses
 * (→ deny with a "proceed anyway" note), or the turn aborts (→ deny).
 * Exported for unit tests.
 */
export function makeCanUseTool(
  projectId: string,
  emit: EventSink,
  signal: AbortSignal,
  contextDirs: string[] = [],
): CanUseTool {
  const dir = projectDir(projectId);
  // The project's own chat-image uploads are readable (never writable) — see
  // projectReadRoots. Granted for every turn, not only turns with attachments,
  // so an image referenced from earlier in the conversation stays openable.
  const extraReadRoots = projectReadRoots(projectId);
  return async (toolName, input, options) => {
    if (toolName !== "AskUserQuestion") {
      // Enforce the file fence before anything runs: the SDK's own tools can
      // otherwise reach any path the OS allows, which would leave "stay in the
      // project" as a mere instruction against untrusted file/web content.
      const fence = checkToolPaths(toolName, input, dir, contextDirs, extraReadRoots);
      if (!fence.ok) return { behavior: "deny", message: fence.message! };
      return { behavior: "allow", updatedInput: input };
    }
    let questions: AgentQuestion[];
    try {
      questions = validateQuestions((input as { questions?: unknown }).questions);
    } catch (err: any) {
      return {
        behavior: "deny",
        message: `The questions were malformed (${err?.message ?? err}) — proceed with your best judgment.`,
      };
    }
    let resolution;
    try {
      resolution = await askUserQuestions(projectId, emit, questions, [signal, options.signal]);
    } catch (err: any) {
      // A second concurrent question — the SDK serializes tool calls, so this
      // is unexpected; fail fast instead of queueing.
      console.warn(`AskUserQuestion denied for ${projectId}: ${err?.message ?? err}`);
      return {
        behavior: "deny",
        message: "Another question is already pending — proceed with your best judgment.",
      };
    }
    if (resolution.kind === "answered") {
      return {
        behavior: "allow",
        updatedInput: { questions: input.questions, answers: resolution.answers },
      };
    }
    if (resolution.kind === "dismissed") {
      return {
        behavior: "deny",
        message: "User declined to answer; proceed with your best judgment.",
      };
    }
    return { behavior: "deny", message: "The turn was interrupted before the questions were answered." };
  };
}

/**
 * The plain text of an SDK tool_result block's content: a string comes back
 * as-is; an array of content blocks contributes its text blocks joined by
 * newlines. Anything else (images, junk) yields "". Exported for unit tests.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * The `prompt` the SDK's query() receives.
 *
 * Without attachments this stays the plain string it has always been — the
 * lowest-risk path, and the one every existing turn takes. With attachments it
 * becomes a single-message async iterable, the SDK's streaming-input form:
 * `SDKUserMessage.message` is an Anthropic `MessageParam`, so its `content`
 * may be a block array — the text block first, then one base64 image block per
 * attachment. Resume/session behaviour is identical either way (the SDK's
 * `resume` option is what carries it, not the prompt shape).
 *
 * Exported for unit tests, which assert the shape without touching the SDK.
 */
export function buildClaudePrompt(
  prompt: string,
  attachments: TurnAttachment[],
): string | AsyncIterable<SDKUserMessage> {
  if (attachments.length === 0) return prompt;
  async function* once(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      // The SDK fills the real session id in; the field is required by the type.
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...attachments.map((a) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: a.mime,
              data: attachmentBase64(a),
            },
          })),
        ],
      },
    } as SDKUserMessage;
  }
  return once();
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
    // Attached images live in DATA_DIR/chat-uploads/<projectId> — outside the
    // working tree on purpose. The CLI must be told about that directory too,
    // or a follow-up Read of the path named in the prompt is refused.
    const extraDirs = ctx.attachments.length > 0 ? [chatUploadsDir(project.id)] : [];
    const openDirs = [...contextDirs, ...extraDirs];
    const disallowed = [
      ...(ctx.readOnly
        ? [...DISALLOWED_TOOLS, "Edit", "Write", "MultiEdit", "NotebookEdit", "mcp__blattbot__add_citation"]
        : DISALLOWED_TOOLS),
      // Hard-block edits inside every directory opened read-only (attached
      // context and the chat-image uploads) — path-scoped permission rules.
      ...openDirs.flatMap((d) => [
        `Edit(${d}/**)`,
        `Write(${d}/**)`,
        `MultiEdit(${d}/**)`,
        `NotebookEdit(${d}/**)`,
      ]),
      // Credentials and BlattBot's own data (Overleaf cookies, API token) are
      // never part of a writing task. Deny rules are evaluated BEFORE the
      // bypassPermissions auto-allow, so these actually bite.
      ...secretDenyRules(),
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
      prompt: buildClaudePrompt(ctx.prompt, ctx.attachments),
      options: {
        cwd: dir,
        ...(openDirs.length > 0 ? { additionalDirectories: openDirs } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
        model: ctx.model,
        env: {
          ...process.env,
          ...(settings.apiKey ? { ANTHROPIC_API_KEY: settings.apiKey } : {}),
          ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Surfaces AskUserQuestion (which always "ask"s, even in bypass mode)
        // as an interactive question card in the chat; allows everything else.
        canUseTool: makeCanUseTool(project.id, ctx.emit, ctx.signal, ctx.contextDirs),
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
    // tool_use id → tool name, so results can be summarized per tool kind.
    const toolNames = new Map<string, string>();

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
              toolNames.set(block.id, block.name);
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
              // Read-only tools get a one-line result summary for the chat;
              // edit tools stay opaque (only livediff's fileDiff is shown).
              const head = resultHead(
                toolNames.get(block.tool_use_id) ?? "",
                toolResultText(block.content),
              );
              ctx.emit({
                type: "tool_result",
                id: block.tool_use_id,
                isError: Boolean(block.is_error),
                ...(head !== undefined ? { resultHead: head } : {}),
              });
            }
          }
          break;
        }
        case "result": {
          ctx.emit({
            type: "turn_end",
            isError: Boolean(m.is_error),
            ...extractResultUsage(m),
            model: ctx.model,
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
 * (The Claude SDK path — agent.ts's runOneShot dispatches here unless the
 * openai backend is active AND fully configured.)
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
