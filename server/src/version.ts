/**
 * Update-available check: the running version (from package.json) vs the
 * latest published npm release. The registry lookup runs non-blocking at boot
 * and is cached in memory for 24 h; every failure is swallowed into "latest
 * unknown" — an offline machine must never notice this exists.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REGISTRY_URL = "https://registry.npmjs.org/blattbot/latest";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_MS = 24 * 60 * 60 * 1000;

/** The server's own version — package.json sits one level above src/ and dist/. */
export function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** True when `latest` is a strictly newer major.minor.patch than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split(".")
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(current), parse(latest)];
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

let cache: { latest: string | null; fetchedAt: number } | null = null;

/** Drop the in-memory cache (tests). */
export function resetVersionCache(): void {
  cache = null;
}

/**
 * The latest published version, or null when unknown (offline, registry down,
 * never published). Results — including failures — are cached for 24 h so the
 * registry sees at most one request a day. `fetchImpl` is injectable for tests.
 */
export async function checkLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.latest;
  let latest: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
      if (res.ok) {
        const data: any = await res.json();
        if (typeof data?.version === "string") latest = data.version;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* offline / registry down — stay unknown until the cache expires */
  }
  cache = { latest, fetchedAt: Date.now() };
  return latest;
}
