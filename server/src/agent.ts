/**
 * Agent turns: mode/scope/prompt assembly, model resolution, and dispatch to
 * the configured backend (backends/claude.ts — the default — or
 * backends/openai.ts). The event contract the backends emit is documented in
 * backends/types.ts; this module owns per-project turn bookkeeping
 * (isTurnActive/interruptTurn) and the error → turn_end mapping.
 */
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { projectDir, type Project, type ProjectSettings } from "./config.js";
import { loadSettings, type Settings } from "./settings.js";
import { contextDirectories } from "./context.js";
import { claudeBackend } from "./backends/claude.js";
import { openaiBackend } from "./backends/openai.js";
import {
  SYSTEM_APPEND,
  resolveModel,
  type AgentBackend,
  type BackendTurnContext,
  type EventSink,
} from "./backends/types.js";

// Shared constants live in backends/types.ts (a dependency leaf both the
// backends and this module import) — re-exported here so every existing
// consumer keeps importing them from agent.js.
export {
  AGENT_TOOL_INFO,
  DEFAULT_MODEL,
  DISALLOWED_TOOLS,
  MODEL_ALIASES,
} from "./backends/types.js";
export { SYSTEM_APPEND, resolveModel };
export type { AgentEvent } from "./backends/types.js";
export { runOneShot } from "./backends/claude.js";

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

// ---- Backends ---------------------------------------------------------------

export const BACKENDS: Record<"claude" | "openai", AgentBackend> = {
  claude: claudeBackend,
  openai: openaiBackend,
};

/** The backend id settings select ("" = claude, the default). */
export function activeBackendId(settings: Settings = loadSettings()): "claude" | "openai" {
  return settings.backend === "openai" ? "openai" : "claude";
}

export function activeBackend(settings: Settings = loadSettings()): AgentBackend {
  return BACKENDS[activeBackendId(settings)];
}

/** The model a turn on this project runs: project override → global setting → default. */
export function resolveProjectModel(project: Pick<Project, "settings">, globalModel: string): string {
  return resolveModel(project.settings?.model?.trim() || globalModel);
}

/**
 * The effective model under the ACTIVE backend. The per-project override
 * applies to whichever backend is active; the claude backend resolves ""
 * and tier aliases, the openai backend uses ids verbatim (openaiModel or the
 * project override, possibly "" when unconfigured).
 */
export function resolveBackendModel(
  project: Pick<Project, "settings"> | undefined,
  settings: Settings,
): string {
  const override = project?.settings?.model?.trim() ?? "";
  if (activeBackendId(settings) === "openai") return override || settings.openaiModel.trim();
  return resolveModel(override || settings.model);
}

// ---- Modes ------------------------------------------------------------------

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

// ---- Scope & per-project settings validation --------------------------------

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

export const MAX_STYLE_APPEND = 4000;
const MAX_PROJECT_MODEL = 200;

/**
 * Validate a PUT /api/projects/:id/settings body. Only the recognized fields
 * are returned (partial — absent keys stay untouched by the caller's merge);
 * every provided field must be a string within its cap, and defaultMode must
 * be an AGENT_MODES id or "". Throws on the first invalid field.
 */
export function validateProjectSettingsPatch(body: unknown): Partial<ProjectSettings> {
  const raw = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<ProjectSettings> = {};
  for (const key of ["styleAppend", "model", "defaultMode"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "string") throw new Error(`${key} must be a string`);
    patch[key] = v;
  }
  if (patch.styleAppend !== undefined && patch.styleAppend.length > MAX_STYLE_APPEND) {
    throw new Error(`styleAppend is too long — the limit is ${MAX_STYLE_APPEND} characters`);
  }
  if (patch.model !== undefined && patch.model.trim().length > MAX_PROJECT_MODEL) {
    throw new Error(`model is too long — the limit is ${MAX_PROJECT_MODEL} characters`);
  }
  if (
    patch.defaultMode !== undefined &&
    patch.defaultMode !== "" &&
    !AGENT_MODES.some((m) => m.id === patch.defaultMode)
  ) {
    throw new Error(
      `defaultMode must be one of ${AGENT_MODES.map((m) => m.id).join(", ")} — or empty for the default`,
    );
  }
  return patch;
}

// ---- Prompt assembly ---------------------------------------------------------

/**
 * Assemble the system-prompt append for one turn, in this order: BlattBot's
 * base append → the mode block → the project's own style instructions
 * (labelled, capped) → the scope restriction → the external-context block →
 * the user's global settings append. Pure, so tests can assert the layout.
 */
export function buildSystemAppend(
  project: Project,
  modeInfo: AgentModeInfo,
  scope: string[] | undefined,
  settings: Settings,
  contextDirs: string[] = contextDirectories(project),
): string {
  let append = SYSTEM_APPEND;
  if (modeInfo.prompt) append += `\n\n${modeInfo.prompt}`;
  // Per-project style/instructions — directly after the mode block, clearly
  // attributed. Re-capped here in case projects.json was edited by hand.
  const styleAppend = project.settings?.styleAppend?.trim();
  if (styleAppend) {
    append += `\n\nProject instructions (from this project's settings):\n${styleAppend.slice(0, MAX_STYLE_APPEND)}`;
  }
  if (scope && scope.length > 0) {
    append +=
      `\n\nThe user has scoped this request to these files — read anything you need, ` +
      `but only EDIT these files: ${scope.join(", ")}. If completing the task truly ` +
      `requires touching other files, say so instead of editing them.`;
  }
  // External read-only context: extra directories the agent may read but never edit.
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
  return append;
}

// ---- Turn dispatch -----------------------------------------------------------

export interface TurnSessionOptions {
  /** Session id to resume — typically the active chat's. Undefined = start fresh. */
  sessionId?: string;
  /** Called when the backend reports a new session id for this turn. */
  onSessionId?: (sessionId: string) => void;
}

/**
 * Run one agent turn over the project working tree, forwarding events to the
 * sink. Resolves when the turn completes (or is aborted). When `session` is
 * given it controls resumption (per-chat sessions); otherwise the legacy
 * per-project sessionId is used. The turn runs on the backend selected in
 * settings ("" = the Claude Agent SDK).
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
  const contextDirs = contextDirectories(project);
  const backend = activeBackend(settings);

  const ctx: BackendTurnContext = {
    project,
    prompt,
    systemAppend: buildSystemAppend(project, modeInfo, scope, settings, contextDirs),
    model: resolveBackendModel(project, settings),
    dir,
    scope,
    contextDirs,
    readOnly: Boolean(modeInfo.readOnly),
    session: {
      sessionId: session ? session.sessionId : project.sessionId,
      onSessionId: session?.onSessionId,
    },
    signal: controller.signal,
    settings,
    emit: onEvent,
  };

  try {
    await backend.runTurn(ctx);
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
