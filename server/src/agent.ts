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
import { abortQuestion } from "./questions.js";
import { claudeBackend, runOneShot as runOneShotClaude } from "./backends/claude.js";
import { openaiBackend, runOneShotOpenai } from "./backends/openai.js";
import {
  SYSTEM_APPEND,
  attachmentNote,
  resolveModel,
  type AgentBackend,
  type BackendTurnContext,
  type EventSink,
  type TurnAttachment,
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

const activeControllers = new Map<string, AbortController>();
// Covers the caller's post-runTurn work too (diff broadcast, recompile) — see
// beginTurnPipeline. Without it, isTurnActive drops as soon as the backend
// call returns, and a second /chat can start while that tail is still
// running two git/tectonic processes against the same working tree at once.
const pipelinesInFlight = new Set<string>();

export function isTurnActive(projectId: string): boolean {
  return activeControllers.has(projectId) || pipelinesInFlight.has(projectId);
}

/** Marks a project's whole turn pipeline (sync → runTurn → diff → recompile) busy. */
export function beginTurnPipeline(projectId: string): void {
  pipelinesInFlight.add(projectId);
}

export function endTurnPipeline(projectId: string): void {
  pipelinesInFlight.delete(projectId);
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

/**
 * Which backend a one-shot call (paper TL;DRs, disclosure polish, …) runs on:
 * the openai backend only when it is active AND fully configured; otherwise
 * the Claude SDK — the default and the fallback for half-configured setups.
 */
export function oneShotBackendId(settings: Settings = loadSettings()): "claude" | "openai" {
  return activeBackendId(settings) === "openai" &&
    settings.openaiBaseUrl.trim() &&
    settings.openaiModel.trim()
    ? "openai"
    : "claude";
}

/**
 * One-shot, tool-less model call → the final text, routed through the
 * configured backend (see oneShotBackendId). Same prompt either way; the
 * openai path is a single non-streaming /chat/completions request.
 */
export async function runOneShot(prompt: string): Promise<string> {
  const settings = loadSettings();
  if (oneShotBackendId(settings) === "openai") return runOneShotOpenai(prompt, settings);
  return runOneShotClaude(prompt);
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

export type AgentMode = "edit" | "research" | "polish" | "review" | "understand";

export interface AgentModeInfo {
  id: AgentMode;
  label: string;
  description: string;
  prompt: string;
  /** Read-only modes (review, understand) block all file-editing tools. */
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
- If a well-known paper still cannot be found by search, write the BibTeX entry yourself from your knowledge, flag it with a "% verify: written from model knowledge" comment, and then run audit_citations on that key — a hand-written entry that does not resolve is very likely wrong.
- Before finishing, run audit_citations on every key you added or edited. Report anything that comes back mismatch or unresolved instead of leaving it silently in the bibliography.
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
    description: "Structured referee report — file edits are blocked.",
    prompt: `Mode: Review — write a structured, venue-style referee report.
Read the relevant files, then structure the report exactly as follows:
1. Summary (3–5 sentences): what the paper does, its main claims, and its contribution.
2. Strengths: bulleted.
3. Weaknesses: bulleted; label each with a severity — major, moderate, or minor.
4. Section-by-section comments: concrete issues per section, in document order.
5. Minor issues: typos, notation inconsistencies, grammar, and LaTeX problems.
6. Rubric — score each dimension /10 with a one-line justification: clarity; technical soundness; support for claims; presentation.
7. Prioritized revision recommendations: what to fix first and why, most important first.
Ground every comment in the actual text: cite the exact location as file.tex:line and quote the passage a comment concerns verbatim in a > blockquote.
You must not modify any files in this mode; file-editing tools are disabled.`,
    readOnly: true,
  },
  {
    id: "understand",
    label: "Understand",
    description: "Explain the project's text and math — file edits are blocked.",
    prompt: `Mode: Understand — explain the project; do not change it.
The user wants to UNDERSTAND, not change: answer questions about the project and explain the concepts, math, and arguments in it — especially text written by co-authors.
- Ground every answer in the actual files: quote the relevant passage verbatim in a > blockquote and cite its location as file.tex:line before explaining it.
- Distinguish clearly between (a) what the text actually says, (b) standard background knowledge, and (c) your interpretation or inference — label each as such.
- If a passage seems wrong or inconsistent, say so plainly and show why.
- Explain in plain language first, then give the precise technical restatement.
- If the question is ambiguous or the right depth is unclear (intuition vs. formal detail), ask with the AskUserQuestion tool.
- When the question refers to linked context directories (papers), read them.
You must not modify any files in this mode; file-editing tools are disabled. If the user asks for changes, tell them to switch to Edit mode.`,
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

/** The prompt an attachments-only message stands in for. */
export const IMAGE_ONLY_PROMPT =
  "Look at the attached image(s) and respond to what they show.";

/**
 * Run one agent turn over the project working tree, forwarding events to the
 * sink. Resolves when the turn completes (or is aborted). When `session` is
 * given it controls resumption (per-chat sessions); otherwise the legacy
 * per-project sessionId is used. The turn runs on the backend selected in
 * settings ("" = the Claude Agent SDK). `attachments` are the images the user
 * put on this message; each backend decides how to carry them.
 */
export async function runTurn(
  project: Project,
  prompt: string,
  onEvent: EventSink,
  mode: AgentMode = "edit",
  scope?: string[],
  session?: TurnSessionOptions,
  attachments: TurnAttachment[] = [],
): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(project.id, controller);
  const dir = projectDir(project.id);
  const settings = loadSettings();
  const modeInfo = AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES[0];
  const contextDirs = contextDirectories(project);
  const backend = activeBackend(settings);

  // A message may be pictures alone ("here's a screenshot" with no words) —
  // give the model the obvious instruction rather than a bare bracket note.
  const text =
    prompt.trim() || (attachments.length > 0 ? IMAGE_ONLY_PROMPT : prompt);

  const ctx: BackendTurnContext = {
    project,
    // Both backends send the images as message content; the note names their
    // on-disk paths so the agent can re-open one later in the turn.
    prompt: text + attachmentNote(attachments),
    systemAppend: buildSystemAppend(project, modeInfo, scope, settings, contextDirs),
    model: resolveBackendModel(project, settings),
    dir,
    scope,
    contextDirs,
    attachments,
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
    // No pending question may outlive its turn — normally the abort signal or
    // the user resolved it already; this covers backend crashes mid-question.
    abortQuestion(project.id);
    activeControllers.delete(project.id);
  }
}
