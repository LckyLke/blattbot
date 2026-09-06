import { CodexClient, codexExecutable } from "./backends/codex-client.js";
import type { ModelOption } from "./models.js";

export interface CodexStatus {
  available: boolean;
  authenticated: boolean;
  authMethod?: string;
  executable: string;
  message: string;
  models: ModelOption[];
  defaultModel?: string;
}

export function normalizeCodexModels(rows: any[]): ModelOption[] {
  const models: ModelOption[] = [];
  for (const r of rows) {
    const id = typeof r?.model === "string" ? r.model.trim() : "";
    if (!id || r.hidden || models.some((m) => m.id === id)) continue;
    const levels = (r.supportedReasoningEfforts ?? []).map((l: any) => l.reasoningEffort).filter((l: unknown) => typeof l === "string");
    models.push({ id, label: r.displayName || id, description: r.description,
      supportsEffort: levels.length > 0, effortLevels: levels });
  }
  return models;
}

let cache: { executable: string; expires: number; promise: Promise<CodexStatus> } | undefined;

export function codexStatus(refresh = false): Promise<CodexStatus> {
  const executable = codexExecutable();
  if (!refresh && cache?.executable === executable && cache.expires > Date.now()) return cache.promise;
  const promise = inspect();
  cache = { executable, expires: Date.now() + 30_000, promise };
  return promise;
}

async function inspect(): Promise<CodexStatus> {
  let client: CodexClient | undefined;
  const base = { executable: codexExecutable(), models: [] as ModelOption[] };
  let available = false;
  try {
    client = new CodexClient();
    await client.initialize();
    available = true;
    const [{ account, requiresOpenaiAuth }, { config }] = await Promise.all([
      client.request("account/read", { refreshToken: false }),
      client.request("config/read", { includeLayers: false }),
    ]);
    const authenticated = Boolean(account) || requiresOpenaiAuth === false;
    const rows: any[] = [];
    let cursor: string | null = null;
    do {
      const page = await client.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      rows.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor && rows.length < 1000);
    return { ...base, available, authenticated, authMethod: account?.type,
      message: authenticated ? "Codex is connected and ready." : "Codex is installed. Run codex login in your terminal, then check again.",
      models: normalizeCodexModels(rows), defaultModel: config?.model || rows.find((r) => r.isDefault)?.model };
  } catch (e: any) {
    return { ...base, available, authenticated: false, message: e.message ?? "Could not connect to Codex." };
  } finally { client?.close(); }
}
