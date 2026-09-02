/**
 * The model list, from the CLI itself. The Agent SDK's query handle answers
 * `supportedModels()` with the engine's own catalog — display names, effort
 * support, aliases with their resolution — so the pick-lists in the UI stop
 * being three hand-maintained copies that go stale with every release.
 *
 * Listing needs a live CLI session: one is started with a streaming prompt
 * that never yields (so no API request is ever made), asked, and closed. The
 * answer is cached per credential configuration for CACHE_MS.
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MODEL, MODEL_ALIASES } from "./backends/types.js";
import { executableOptions } from "./sdkinfo.js";
import type { Settings } from "./settings.js";

export interface ModelOption {
  /** The id to configure — a full model id, or an alias the CLI resolves. */
  id: string;
  /** What an alias resolves to (absent for concrete ids). */
  resolvesTo?: string;
  label: string;
  description?: string;
  supportsEffort?: boolean;
  effortLevels?: string[];
}

export interface ModelList {
  models: ModelOption[];
  /** "cli" when the engine answered; "static" for the built-in fallback. */
  source: "cli" | "static";
}

/** The built-in fallback: the ids BlattBot's aliases map to, plus the aliases. */
export function staticModelList(): ModelList {
  const ids = [DEFAULT_MODEL, ...Object.values(MODEL_ALIASES)].filter((v, i, a) => a.indexOf(v) === i);
  const models: ModelOption[] = [
    ...ids.map((id) => ({ id, label: id })),
    ...Object.entries(MODEL_ALIASES).map(([alias, target]) => ({
      id: alias,
      resolvesTo: target,
      label: `${alias} → ${target}`,
    })),
  ];
  return { models, source: "static" };
}

/**
 * Normalize the SDK's ModelInfo rows. The engine answers with its picker's
 * rows — CLI-side aliases such as "opus[1m]" or "default" plus the concrete
 * id each resolves to. BlattBot resolves aliases itself, so what the list
 * offers is the resolved concrete ids (deduped, first display name wins),
 * followed by BlattBot's own tier aliases. Drops unusable entries.
 */
export function normalizeModelInfo(rows: unknown): ModelOption[] {
  const out: ModelOption[] = [];
  if (Array.isArray(rows)) {
    for (const r of rows as any[]) {
      const value = typeof r?.value === "string" ? r.value.trim() : "";
      if (!value || value === "default") continue;
      const id = typeof r.resolvedModel === "string" && r.resolvedModel.trim() ? r.resolvedModel.trim() : value;
      if (out.some((m) => m.id === id)) continue;
      const opt: ModelOption = {
        id,
        label: typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim() : id,
      };
      if (typeof r.description === "string" && r.description.trim()) opt.description = r.description.trim();
      if (typeof r.supportsEffort === "boolean") opt.supportsEffort = r.supportsEffort;
      if (Array.isArray(r.supportedEffortLevels)) {
        opt.effortLevels = r.supportedEffortLevels.filter((l: unknown) => typeof l === "string");
      }
      out.push(opt);
    }
  }
  if (out.length === 0) return out;
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    out.push({ id: alias, resolvesTo: target, label: `${alias} → ${target}` });
  }
  return out;
}

const CACHE_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 25_000;
let cache: { key: string; at: number; list: Promise<ModelList> } | undefined;

async function* silence(): AsyncGenerator<SDKUserMessage> {
  // Keeps the session's input open without ever sending a turn.
  await new Promise<never>(() => {});
}

async function askCli(settings: Settings): Promise<ModelList> {
  const q = query({
    prompt: silence(),
    options: {
      settingSources: [],
      permissionMode: "default",
      allowedTools: [],
      maxTurns: 1,
      ...executableOptions(),
      env: {
        ...process.env,
        ...(settings.apiKey ? { ANTHROPIC_API_KEY: settings.apiKey } : {}),
        ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
      },
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const rows = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("model list timed out")), LIST_TIMEOUT_MS);
      }),
    ]);
    const models = normalizeModelInfo(rows);
    if (models.length === 0) throw new Error("the engine listed no models");
    return { models, source: "cli" };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

/**
 * The model list for the Claude backend: the engine's catalog when it can be
 * asked, else the static fallback. Never throws. `refresh` bypasses the cache.
 */
export async function listModels(settings: Settings, refresh = false): Promise<ModelList> {
  const key = `${settings.apiKey ? "key" : "login"}|${settings.anthropicBaseUrl}`;
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.list;
  const list = askCli(settings).catch((err) => {
    console.warn(`model list: falling back to the static list (${err?.message ?? err})`);
    cache = undefined; // a failure is not worth caching for 10 minutes
    return staticModelList();
  });
  cache = { key, at: Date.now(), list };
  return list;
}
