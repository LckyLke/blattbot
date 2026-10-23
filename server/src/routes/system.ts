// Bootstrap (token handoff), health, version, settings, models and agent info.
import type { FastifyInstance } from "fastify";
import { codexLimits } from "../agent-limits.js";
import { detectEngine } from "../compile.js";
import {
  AGENT_MODES,
  AGENT_TOOL_INFO,
  DISALLOWED_TOOLS,
  MODEL_ALIASES,
  SYSTEM_APPEND,
  activeBackendId,
  resolveBackendModel,
  resolveModel,
} from "../agent.js";
import {
  ASK_USER_TOOL_INFO,
  EFFORT_LEVELS,
  isEffortLevel,
  resolveFallbackModel,
} from "../backends/types.js";
import { checkLatestVersion, currentVersion } from "../version.js";
import { listModels } from "../models.js";
import { agentSdkVersion, describeEngine } from "../sdkinfo.js";
import {
  MAX_HISTORY_MESSAGES,
  OPENAI_SYSTEM_PROMPT,
  OPENAI_TOOL_INFO,
  openaiBackend,
} from "../backends/openai.js";
import { claudeBackend } from "../backends/claude.js";
import { codexBackend, CODEX_EFFORT_LEVELS, CODEX_SYSTEM_PROMPT } from "../backends/codex.js";
import { codexStatus } from "../codexinfo.js";
import { codexExecutable } from "../backends/codex-client.js";
import { RESEARCH_TOOLS } from "../research/tools.js";
import { DATA_DIR, PROJECTS_DIR } from "../config.js";
import { AUTH_COOKIE } from "../auth.js";
import { loadSettings, publicSettings, saveSettings, type Settings } from "../settings.js";
import { checkResearchProvider } from "../research-providers.js";

export function registerSystemRoutes(app: FastifyInstance, authToken: string): void {
  /** Same-origin token handoff: sets the auth cookie and returns the token. */
  app.get("/api/bootstrap", async (req, reply) => {
    reply.header(
      "Set-Cookie",
      `${AUTH_COOKIE}=${authToken}; Path=/; SameSite=Strict; HttpOnly`,
    );
    return { ok: true, token: authToken };
  });

  app.get("/api/health", async () => {
    const engine = await detectEngine(loadSettings().engine || undefined);
    return { ok: true, engine: engine?.name ?? null };
  });

  // Update check: the npm lookup is warmed at boot (see the listen block) and
  // cached for 24 h — this answers from that cache. latest is null when unknown.
  app.get("/api/version", async () => ({
    current: currentVersion(),
    latest: await checkLatestVersion(),
  }));

  // ---- Settings & transparency ----------------------------------------------

  // resolvedModel: what the active backend will actually run — "" and aliases
  // resolved for claude, the configured id verbatim for openai.
  app.get("/api/settings", async () => {
    const s = loadSettings();
    return { ...publicSettings(s), resolvedModel: resolveBackendModel(undefined, s) };
  });

  app.put<{ Body: Partial<Settings> }>("/api/settings", async (req, reply) => {
    const body = req.body ?? {};
    if (body.unpaywallEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.unpaywallEmail)) return reply.code(400).send({ error: "Enter a valid contact email for Unpaywall." });
    if (body.backend !== undefined && !["", "codex", "claude", "openai"].includes(body.backend)) {
      return reply.code(400).send({ error: "backend must be codex, claude, openai, or empty" });
    }
    if (body.codexEffort !== undefined && body.codexEffort !== "" && !(CODEX_EFFORT_LEVELS as readonly unknown[]).includes(body.codexEffort)) {
      return reply.code(400).send({ error: `codexEffort must be one of ${CODEX_EFFORT_LEVELS.join(", ")} or empty` });
    }
    if (body.codexServiceTier !== undefined && !["", "default", "priority"].includes(body.codexServiceTier)) {
      return reply.code(400).send({ error: "codexServiceTier must be default (Standard), priority (Fast), or empty" });
    }
    if (body.effort !== undefined && body.effort !== "" && !isEffortLevel(body.effort)) {
      return reply.code(400).send({ error: `effort must be one of ${EFFORT_LEVELS.join(", ")} or empty` });
    }
    const s = saveSettings(body);
    return { ...publicSettings(s), resolvedModel: resolveBackendModel(undefined, s) };
  });

  app.post<{ Body: { provider?: string } }>("/api/settings/research/check", async (req, reply) => {
    const provider = req.body?.provider;
    if (provider !== "semantic-scholar" && provider !== "openalex" && provider !== "brave-search") return reply.code(400).send({ error: "Unknown research provider" });
    return checkResearchProvider(provider);
  });

  // Model suggestions for the selected harness. Settings can preview another
  // backend without saving it. ?refresh=1 re-asks its CLI.
  app.get<{ Querystring: { refresh?: string; backend?: string } }>("/api/models", async (req, reply) => {
    const s = loadSettings();
    if (req.query.backend !== undefined) {
      if (!["codex", "claude", "openai"].includes(req.query.backend)) return reply.code(400).send({ error: "Unknown backend" });
      s.backend = req.query.backend as Settings["backend"];
    }
    return listModels(s, req.query.refresh === "1");
  });

  app.get("/api/agent/codex/limits", async () => codexLimits());

  app.get<{ Querystring: { refresh?: string } }>("/api/agent/codex/status", async (req) => {
    const { models, ...status } = await codexStatus(req.query.refresh === "1");
    return status;
  });

  // Reflects the ACTIVE backend (Settings → Agent): id, endpoint, model, tools.
  app.get("/api/agent/info", async () => {
    const s = loadSettings();
    const common = {
      modes: AGENT_MODES,
      userSystemPromptAppend: s.systemPromptAppend,
      dataDir: DATA_DIR,
      projectsDir: PROJECTS_DIR,
    };
    if (activeBackendId(s) === "codex") {
      return { ...common, backend: "codex", backendLabel: codexBackend.label,
        backendDescription: codexBackend.description, model: s.codexModel.trim() || "Codex CLI default",
        engine: codexExecutable(), effort: s.codexEffort || "Codex default", usingApiKey: false,
        endpoint: "Configured in your local Codex CLI", authLabel: "Codex login / CLI credentials",
        systemPromptAppend: CODEX_SYSTEM_PROMPT, tools: OPENAI_TOOL_INFO, disallowedTools: [],
        sessionNote: "Codex conversations resume per chat. Switching backends starts a new conversation; earlier chat messages stay visible. Token usage is reported; dollar cost is not supplied by Codex.",
      };
    }
    if (activeBackendId(s) === "openai") {
      const base = s.openaiBaseUrl.trim().replace(/\/+$/, "");
      return {
        backend: "openai-compatible",
        backendLabel: openaiBackend.label,
        backendDescription: openaiBackend.description,
        model: s.openaiModel.trim() || "(not set — configure it in Settings → Agent)",
        usingApiKey: Boolean(s.openaiApiKey),
        endpoint: base ? `${base}/chat/completions` : "(base URL not set)",
        systemPromptAppend: OPENAI_SYSTEM_PROMPT,
        tools: OPENAI_TOOL_INFO,
        disallowedTools: [],
        sessionNote:
          `Conversation memory is a local message log under ${DATA_DIR}/oai-sessions, capped at ` +
          `${MAX_HISTORY_MESSAGES} messages — there is no provider-side session resume across ` +
          `restarts beyond that stored history.`,
        ...common,
      };
    }
    return {
      backend: "claude-agent-sdk",
      backendLabel: claudeBackend.label,
      backendDescription: claudeBackend.description,
      model: `${resolveModel(s.model)}${s.model ? "" : " (BlattBot default)"}`,
      modelAliases: MODEL_ALIASES,
      effort: s.effort || "(model default)",
      engine: `Agent SDK ${agentSdkVersion() ?? "?"} · ${describeEngine()}`,
      fallbackModel:
        resolveFallbackModel(resolveModel(s.model), s.fallbackModel) ??
        (s.fallbackModel.trim() ? "(none)" : "(none — automatic Opus 5 behind a Fable-family model)"),
      usingApiKey: Boolean(s.apiKey),
      endpoint: s.anthropicBaseUrl || "https://api.anthropic.com",
      anthropicBaseUrl: s.anthropicBaseUrl || "https://api.anthropic.com",
      systemPromptPreset: "claude_code",
      systemPromptAppend: SYSTEM_APPEND,
      tools: [...AGENT_TOOL_INFO, ...RESEARCH_TOOLS.map(({ name, description }) => ({ name, description })), ASK_USER_TOOL_INFO],
      disallowedTools: DISALLOWED_TOOLS,
      ...common,
    };
  });
}
