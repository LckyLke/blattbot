import { CodexClient, codexExecutable } from "./backends/codex-client.js";

export interface UsageWindow {
  bucket: string;
  window: string;
  remainingPercent: number;
  resetsAt?: number;
}
export interface UsageLimits {
  windows: UsageWindow[];
  checkedAt: number;
  message?: string;
}

export function normalizeLimits(response: any): UsageWindow[] {
  const buckets = response?.rateLimitsByLimitId;
  const entries: [string, any][] = buckets && Object.keys(buckets).length
    ? Object.entries(buckets) : response?.rateLimits ? [["codex", response.rateLimits]] : [];
  return entries.flatMap(([id, bucket]) => ["primary", "secondary"].flatMap((key) => {
    const value = bucket?.[key];
    if (typeof value?.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return [];
    const mins = value.windowDurationMins;
    const window = typeof mins === "number" && mins > 0
      ? mins % 10080 === 0 ? `${mins / 10080} week`
        : mins % 1440 === 0 ? `${mins / 1440} day`
        : mins % 60 === 0 ? `${mins / 60} hour` : `${mins} minute`
      : key === "primary" ? "Primary" : "Secondary";
    return [{
      bucket: bucket.limitName || bucket.limitId || id,
      window,
      remainingPercent: Math.max(0, Math.min(100, 100 - value.usedPercent)),
      ...(typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt) ? { resetsAt: value.resetsAt } : {}),
    }];
  }));
}

let cache: { executable: string; expires: number; promise: Promise<UsageLimits> } | undefined;
export function codexLimits(): Promise<UsageLimits> {
  const executable = codexExecutable();
  if (cache?.executable === executable && cache.expires > Date.now()) return cache.promise;
  const promise = inspect();
  cache = { executable, expires: Date.now() + 15_000, promise };
  return promise;
}
async function inspect(): Promise<UsageLimits> {
  let client: CodexClient | undefined;
  try {
    client = new CodexClient();
    await client.initialize();
    const windows = normalizeLimits(await client.request("account/rateLimits/read", {}));
    return { windows, checkedAt: Date.now(), ...(!windows.length ? { message: "This Codex account does not report usage limits." } : {}) };
  } catch (error) {
    return { windows: [], checkedAt: Date.now(), message: `Usage limits unavailable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await client?.close();
  }
}
