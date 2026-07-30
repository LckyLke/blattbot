/**
 * User-configurable settings, stored transparently as JSON in the data dir.
 * Everything has a safe default; an empty string means "use the default".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureDirs } from "./config.js";

const SETTINGS_PATH = join(DATA_DIR, "settings.json");

export interface Settings {
  /** Model override for the agent, e.g. "sonnet", "opus", or a full model id. "" = the Claude Code default. */
  model: string;
  /** API key for the Anthropic(-compatible) endpoint. "" = reuse the local Claude Code login. */
  apiKey: string;
  /** Base URL of an Anthropic-compatible endpoint (proxies like LiteLLM). "" = api.anthropic.com. */
  anthropicBaseUrl: string;
  /** Extra instructions appended to the agent's system prompt. */
  systemPromptAppend: string;
  /** Preferred TeX engine. "" = auto-detect (tectonic → latexmk → pdflatex). */
  engine: "" | "tectonic" | "latexmk" | "pdflatex";
  /** Optional Semantic Scholar API key — lifts the shared-pool rate limit on paper search. */
  s2ApiKey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  model: "",
  apiKey: "",
  anthropicBaseUrl: "",
  systemPromptAppend: "",
  engine: "",
  s2ApiKey: "",
};

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings() };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const v = patch[key];
    if (typeof v === "string") (next as any)[key] = v;
  }
  ensureDirs();
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Settings as sent to the UI — key material never leaves the server. */
export function publicSettings(s = loadSettings()) {
  const { apiKey, s2ApiKey, ...rest } = s;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    hasS2ApiKey: Boolean(s2ApiKey),
    settingsPath: SETTINGS_PATH,
  };
}
