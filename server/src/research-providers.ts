/** Shared provider transport: search and paper reading consume the same quota. */
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
import { loadSettings } from "./settings.js";
import { researchSignal } from "./research/store.js";

export class RateLimitError extends Error {
  constructor(
    public retryAt = Date.now() + 60_000,
    public keyConfigured = !!loadSettings().s2ApiKey.trim(),
  ) {
    super(
      keyConfigured
        ? `Semantic Scholar rate limited (HTTP 429). The saved API key was sent; personal keys still have a request limit. Retry after ${new Date(retryAt).toLocaleTimeString()}.`
        : `Semantic Scholar rate limited (HTTP 429). No API key is configured on this server. Use “Save & test Semantic Scholar key” in Settings, or retry after ${new Date(retryAt).toLocaleTimeString()}.`,
    );
    this.name = "RateLimitError";
  }
}
interface Bucket {
  nextAt: number;
  cooldownUntil: number;
}
const buckets = new Map<string, Bucket>();
export function researchProviderRetryAt(): number {
  return buckets.get(loadSettings().s2ApiKey.trim())?.cooldownUntil ?? 0;
}
const cache = new Map<string, { expires: number; value: any }>();
let queue: Promise<unknown> = Promise.resolve();
interface ScholarRequestOptions {
  signal?: AbortSignal;
  fresh?: boolean;
  /** Reuse title resolution for a known paper, while general searches stay fresh. */
  cache?: boolean;
}
async function semanticScholarRequest(
  path: string,
  options: ScholarRequestOptions & { body?: { ids: string[] } } = {},
): Promise<any | null> {
  if (!path.startsWith("/")) throw new Error("Invalid Semantic Scholar path");
  const signal = options.signal ?? researchSignal();
  // Share paper metadata between PDF and abstract lookups. Search must reflect
  // the current provider response, including outages and newly indexed papers.
  const cacheable = options.cache ?? !path.startsWith("/paper/search");
  const run = async () => {
    let cooldownWaitMs = 0;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      // Settings may change while this request is queued or backing off. A newly
      // saved key must not inherit the anonymous pool's cache or cooldown.
      const key = loadSettings().s2ApiKey.trim();
      const cacheKey = `${key}:${path}:${options.body ? JSON.stringify(options.body) : ""}`;
      const saved = cacheable ? cache.get(cacheKey) : undefined;
      if (!options.fresh && saved && saved.expires > Date.now())
        return saved.value;
      const bucket = buckets.get(key) ?? { nextAt: 0, cooldownUntil: 0 };
      buckets.set(key, bucket);
      const cooldown = bucket.cooldownUntil - Date.now();
      if (cooldown > 0) {
        // Recover brief authenticated throttling without holding all the other
        // providers behind a long Retry-After. Never shorten the server's delay.
        if (!key || cooldownWaitMs + cooldown > 10_000)
          throw new RateLimitError(bucket.cooldownUntil, !!key);
        cooldownWaitMs += cooldown;
        await delay(cooldown, signal);
      }
      const wait = key ? bucket.nextAt - Date.now() : 0;
      if (wait > 0) await delay(wait, signal);
      signal?.throwIfAborted();
      bucket.nextAt = Date.now() + 1100;
      const response = await fetch(
        `https://api.semanticscholar.org/graph/v1${path}`,
        {
          headers: {
            ...(key ? { "x-api-key": key } : {}),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(options.body
            ? { method: "POST", body: JSON.stringify(options.body) }
            : {}),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
            : AbortSignal.timeout(20_000),
          redirect: "error",
        },
      );
      if (response.status === 429) {
        const after = response.headers?.get?.("retry-after");
        const time = after
          ? /^\d+(\.\d+)?$/.test(after)
            ? Date.now() + Number(after) * 1000
            : Date.parse(after)
          : NaN;
        bucket.cooldownUntil = Number.isFinite(time)
          ? Math.max(Date.now() + 1100, time)
          : Date.now() + (key ? 2000 * 2 ** attempt : 60_000);
        if (!key || attempt >= 2)
          throw new RateLimitError(bucket.cooldownUntil, !!key);
        continue;
      }
      if ([401, 403].includes(response.status))
        throw new Error(
          `Semantic Scholar rejected the request (HTTP ${response.status}). ${key ? "A saved API key was sent; check its validity and access permissions in Settings." : "No API key is configured in this installation."}`,
        );
      if (!response.ok && response.status !== 404)
        throw new Error(`Semantic Scholar: HTTP ${response.status}`);
      const value = response.status === 404 ? null : await response.json();
      if (options.body && (!Array.isArray(value) || value.length !== options.body.ids.length ||
        value.some(row => row !== null && (typeof row !== "object" || Array.isArray(row)))))
        throw new Error("Semantic Scholar returned an invalid paper batch response.");
      if (cacheable) {
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, {
          expires: Date.now() + (value ? 5 * 60_000 : 60_000),
          value,
        });
      }
      return value;
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

export function semanticScholarGet(
  path: string,
  options: ScholarRequestOptions = {},
) {
  return semanticScholarRequest(path, options);
}

/** The supported batch endpoint shares the same key pacing and Retry-After queue. */
export async function semanticScholarPaperBatch(
  ids: string[],
  fields: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<(any | null)[]> {
  if (!ids.length) return [];
  const value = await semanticScholarRequest(
    `/paper/batch?fields=${encodeURIComponent(fields)}`,
    { ...options, body: { ids } },
  );
  if (!Array.isArray(value) || value.length !== ids.length)
    throw new Error(
      "Semantic Scholar returned an invalid paper batch response.",
    );
  return value;
}
export function openAlexHeaders(): Record<string, string> {
  const key =
    loadSettings().openAlexApiKey.trim() ||
    process.env.OPENALEX_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}
export async function checkResearchProvider(
  provider: "semantic-scholar" | "openalex" | "brave-search",
) {
  const settings = loadSettings();
  if (provider === "brave-search") {
    const key = settings.braveSearchApiKey.trim();
    if (!key) return { provider, configured: false, status: "not_configured", message: "No Brave Search key is saved. Paper discovery uses public web search, which may be temporarily blocked." };
    try {
      const response = await fetch("https://api.search.brave.com/res/v1/web/search?q=description%20logic&count=1", { headers: { "X-Subscription-Token": key, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
      return { provider, configured: true, status: response.ok ? "ok" : response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "rejected" : "unavailable", message: response.ok ? "The configured search key was sent and web search succeeded." : `Brave Search returned HTTP ${response.status}. The configured key was sent.` };
    } catch { return { provider, configured: true, status: "unavailable", message: "Brave Search could not be reached. The saved key has not been validated." }; }
  }
  const configured =
    provider === "semantic-scholar"
      ? !!settings.s2ApiKey.trim()
      : !!(
          settings.openAlexApiKey.trim() || process.env.OPENALEX_API_KEY?.trim()
        );
  try {
    if (provider === "semantic-scholar") {
      const data = configured
        ? (
            await semanticScholarPaperBatch(["ARXIV:1706.03762"], "title", {
              fresh: true,
            })
          )[0]
        : await semanticScholarGet("/paper/ARXIV:1706.03762?fields=title", {
            fresh: true,
          });
      if (!data)
        return {
          provider,
          configured,
          status: "unavailable",
          message:
            "The service responded but did not return the test paper. Key validity is not confirmed.",
        };
    } else {
      const r = await fetch(
        "https://api.openalex.org/works/W2741809807?select=id",
        {
          headers: openAlexHeaders(),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!r.ok)
        return {
          provider,
          configured,
          status:
            r.status === 429
              ? "rate_limited"
              : [401, 403].includes(r.status)
                ? "rejected"
                : "unavailable",
          message: `OpenAlex returned HTTP ${r.status}. ${configured ? "The configured key was sent." : "This installation is using anonymous access."}`,
        };
    }
    return {
      provider,
      configured,
      status: "ok",
      message: configured
        ? "The configured key was sent and the lookup succeeded."
        : "Anonymous lookup succeeded. No key is configured in this installation.",
    };
  } catch (error: any) {
    return {
      provider,
      configured,
      status:
        error instanceof RateLimitError
          ? "rate_limited"
          : /HTTP (401|403)/.test(error.message)
            ? "rejected"
            : "unavailable",
      message: error.message,
      ...(error instanceof RateLimitError
        ? { retryAt: new Date(error.retryAt).toISOString() }
        : {}),
    };
  }
}

export async function unpaywallPdfUrls(
  doi: string | undefined,
): Promise<string[]> {
  const email = loadSettings().unpaywallEmail.trim();
  if (!doi || !email) return [];
  const signal = researchSignal();
  const response = await fetch(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
    {
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) return [];
  const record: any = await response.json();
  if (
    typeof record.doi !== "string" ||
    record.doi.toLowerCase() !== doi.toLowerCase()
  )
    return [];
  return [
    ...new Set<string>(
      [record.best_oa_location, ...(record.oa_locations ?? [])].flatMap(
        (location) =>
          typeof location?.url_for_pdf === "string" &&
          /^https?:\/\//i.test(location.url_for_pdf)
            ? [location.url_for_pdf]
            : [],
      ),
    ),
  ].slice(0, 5);
}
