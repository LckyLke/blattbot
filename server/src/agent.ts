import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { getProject, projectDir, updateProject, type Project } from "./config.js";
import { compileProject } from "./compile.js";
import { addCitation, readAllBibEntries, searchPapers } from "./citations.js";
import { loadSettings } from "./settings.js";
import { contextDirectories } from "./context.js";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventSink = (event: AgentEvent) => void;

const activeControllers = new Map<string, AbortController>();

export function isTurnActive(projectId: string): boolean {
  return activeControllers.has(projectId);
}

export function interruptTurn(projectId: string): boolean {
  const controller = activeControllers.get(projectId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Descriptions of the project-specific tools, also served by /api/agent/info. */
export const AGENT_TOOL_INFO = [
  {
    name: "compile_latex",
    description:
      "Compile the LaTeX project and report success or the exact compiler errors. Use this to verify your edits.",
  },
  {
    name: "search_papers",
    description:
      "Search academic literature across Semantic Scholar, DBLP, and Crossref in parallel — Semantic Scholar and DBLP cover ML venues (NeurIPS, ICML, ICLR) that Crossref misses. Returns title, authors, year, venue, citation count, and a cite-ref to pass to add_citation.",
  },
  {
    name: "add_citation",
    description:
      "Fetch BibTeX for a cite-ref — a DOI, dblp:<key>, or arxiv:<id> as returned by search_papers — dedupe against the project's bibliography, and append it to a .bib file. Returns the cite key to use in \\cite{...}.",
  },
  {
    name: "list_citations",
    description: "List all entries currently in the project's .bib files (key, title, year).",
  },
] as const;

/**
 * BlattBot resolves models itself instead of trusting the CLI's alias table
 * (whose "sonnet" may pin to an older snapshot). Empty setting = newest Sonnet;
 * tier aliases always map to the newest model of that tier.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
  fable: "claude-fable-5",
  haiku: "claude-haiku-4-5-20251001",
};

export function resolveModel(configured: string): string {
  const c = configured.trim();
  if (!c) return DEFAULT_MODEL;
  return MODEL_ALIASES[c.toLowerCase()] ?? c;
}

export type AgentMode = "edit" | "research" | "polish" | "review";

export interface AgentModeInfo {
  id: AgentMode;
  label: string;
  description: string;
  prompt: string;
  /** Review mode blocks all file-editing tools. */
  readOnly?: boolean;
}

/** Operating modes: a named focus the user picks per message. Shown in Settings → Transparency. */
export const AGENT_MODES: AgentModeInfo[] = [
  {
    id: "edit",
    label: "Edit",
    description: "General writing and editing — the default.",
    prompt: "",
  },
  {
    id: "research",
    label: "Research",
    description: "Find literature and fill missing citations.",
    prompt: `Mode: Research — literature search and citations.
- Work through missing or TODO-marked citations systematically. Use search_papers (it queries Semantic Scholar, DBLP, and Crossref in parallel); if a first query misses, vary the phrasing or search by author and venue before giving up.
- Add entries with add_citation using the cite-ref from the search results, then insert \\cite{...} at the marked spot and remove the TODO marker.
- Prefer the canonical original publication over surveys or re-prints.
- If a well-known paper still cannot be found by search, write the BibTeX entry yourself from your knowledge and flag it with a "% verify: written from model knowledge" comment.
- Do not rewrite prose beyond inserting citations. Finish the task; do not stop to ask which approach to take.`,
  },
  {
    id: "polish",
    label: "Polish",
    description: "Grammar, style, and LaTeX consistency only.",
    prompt: `Mode: Polish — proofreading pass.
- Fix grammar, spelling, punctuation, awkward phrasing, and LaTeX consistency (labels, \\ref/\\autoref usage, math notation, heading capitalization).
- Preserve meaning, structure, voice, and citations exactly. Do not add or remove content.`,
  },
  {
    id: "review",
    label: "Review",
    description: "Read-only feedback — file edits are blocked.",
    prompt: `Mode: Review — feedback only.
- Read the relevant files and reply with concrete, prioritized feedback: argument structure, clarity, missing citations, notation and LaTeX issues.
- You must not modify any files in this mode; file-editing tools are disabled.`,
    readOnly: true,
  },
];

export const DISALLOWED_TOOLS = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git rebase:*)",
];

export const SYSTEM_APPEND = `
You are BlattBot, an expert LaTeX writing assistant operating on a snapshot of an Overleaf project.

Context:
- The current directory is a git clone of the user's Overleaf project. Edit files directly with your file tools.
- Your edits are NOT pushed automatically. After your turn, the user reviews a diff and approves or rejects it. Therefore: never run git commit, git push, git checkout, or git reset — the harness owns version control.
- After making non-trivial edits to .tex or .bib files, verify the document still compiles using the mcp__blattbot__compile_latex tool. If compilation fails, read the errors and fix them before finishing.
- You may create new files and delete files that become obsolete — creations and deletions go through the same review diff as edits.

Citations:
- To find papers, use mcp__blattbot__search_papers. Present the best candidates to the user with title, authors, year, and venue when the choice is not obvious.
- To add a reference, use mcp__blattbot__add_citation with the DOI — it fetches BibTeX, dedupes against the existing bibliography, writes the entry, and returns the cite key to use in \\cite{...}.
- Use mcp__blattbot__list_citations to see what is already in the bibliography; prefer citing existing entries over adding near-duplicates.

Style:
- Preserve the document's existing LaTeX conventions (macros, environments, label naming, bibliography style).
- Make focused edits; do not reformat or restructure beyond what was asked.
`.trim();

export const MAX_SCOPE_FILES = 50;

/**
 * Validate a user-supplied edit scope: relative paths inside the project
 * that exist as regular files, capped at MAX_SCOPE_FILES. Throws on any
 * invalid entry so the chat endpoint can reject the request up front.
 */
export function validateScope(dir: string, files: unknown): string[] {
  if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) {
    throw new Error("files must be an array of strings");
  }
  if (files.length > MAX_SCOPE_FILES) {
    throw new Error(`too many scoped files — the limit is ${MAX_SCOPE_FILES}`);
  }
  const out: string[] = [];
  for (const raw of files as string[]) {
    const rel = raw.trim();
    if (!rel) throw new Error("scope contains an empty path");
    const abs = resolve(dir, rel);
    if (abs === dir || !abs.startsWith(dir + sep)) throw new Error(`invalid scope path: ${rel}`);
    let isFile = false;
    try {
      isFile = statSync(abs).isFile();
    } catch {
      /* missing */
    }
    if (!isFile) throw new Error(`scoped file does not exist: ${rel}`);
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

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

export interface TurnSessionOptions {
  /** Session id to resume — typically the active chat's. Undefined = start fresh. */
  sessionId?: string;
  /** Called when the SDK reports a new session id for this turn. */
  onSessionId?: (sessionId: string) => void;
}

/**
 * Run one agent turn over the project working tree, forwarding events to the sink.
 * Resolves when the turn completes (or is aborted). When `session` is given it
 * controls resumption (per-chat sessions); otherwise the legacy per-project
 * sessionId is used.
 */
export async function runTurn(
  project: Project,
  prompt: string,
  onEvent: EventSink,
  mode: AgentMode = "edit",
  scope?: string[],
  session?: TurnSessionOptions,
): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(project.id, controller);
  const dir = projectDir(project.id);
  const settings = loadSettings();
  const modeInfo = AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES[0];
  let append = SYSTEM_APPEND;
  if (modeInfo.prompt) append += `\n\n${modeInfo.prompt}`;
  if (scope && scope.length > 0) {
    append +=
      `\n\nThe user has scoped this request to these files — read anything you need, ` +
      `but only EDIT these files: ${scope.join(", ")}. If completing the task truly ` +
      `requires touching other files, say so instead of editing them.`;
  }
  // External read-only context: extra directories the agent may read but never edit.
  const contextDirs = contextDirectories(project);
  if (contextDirs.length > 0) {
    append +=
      `\n\nExternal read-only context is attached (reference material — code, data, literature):\n` +
      contextDirs.map((d) => `- ${d}`).join("\n") +
      `\nRead and search these freely (Read, Grep, Glob — Read handles PDFs too), but NEVER ` +
      `create, modify, or delete anything inside them, and never copy their content into the ` +
      `project verbatim beyond normal quotation.`;
  }
  if (settings.systemPromptAppend.trim()) {
    append += `\n\nAdditional instructions from the user's BlattBot settings:\n${settings.systemPromptAppend.trim()}`;
  }
  const disallowed = [
    ...(modeInfo.readOnly
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

  const resumeId = session ? session.sessionId : project.sessionId;

  try {
    const q = query({
      prompt,
      options: {
        cwd: dir,
        ...(contextDirs.length > 0 ? { additionalDirectories: contextDirs } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
        model: resolveModel(settings.model),
        env: {
          ...process.env,
          ...(settings.apiKey ? { ANTHROPIC_API_KEY: settings.apiKey } : {}),
          ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController: controller,
        systemPrompt: { type: "preset", preset: "claude_code", append },
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
            session?.onSessionId?.(m.session_id);
          }
          break;
        }
        case "stream_event": {
          const ev = m.event;
          if (ev?.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta" && ev.delta.text) {
              thinkingNotified = false;
              onEvent({ type: "text_delta", text: ev.delta.text });
            } else if (ev.delta?.type === "thinking_delta" && !thinkingNotified) {
              thinkingNotified = true;
              onEvent({ type: "thinking" });
            }
          } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
            onEvent({
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
              onEvent({ type: "text_final", text: block.text });
            } else if (block.type === "tool_use") {
              onEvent({
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
              onEvent({
                type: "tool_result",
                id: block.tool_use_id,
                isError: Boolean(block.is_error),
              });
            }
          }
          break;
        }
        case "result": {
          onEvent({
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
  } catch (err: any) {
    if (controller.signal.aborted) {
      onEvent({ type: "turn_end", isError: false, interrupted: true });
    } else {
      onEvent({ type: "error", message: String(err?.message ?? err) });
      onEvent({ type: "turn_end", isError: true });
    }
  } finally {
    activeControllers.delete(project.id);
  }
}

/**
 * One-shot, tool-less model call → the final text. Used for tiny generation
 * tasks like condensing a paper abstract into a TL;DR. Shares the agent's
 * model/key/base-URL settings but never touches files or sessions.
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
