/**
 * First-run bootstrap: download a tectonic release binary into DATA_DIR/bin.
 *
 * URL construction is a pure function (unit-tested); the installer downloads
 * the archive (through HTTPS_PROXY/HTTP_PROXY when set, with a timeout),
 * checks it against the SHA-256 digest GitHub's release API reports for the
 * asset, unpacks it by shelling out to the system `tar` (present on Linux,
 * macOS, and Windows 10+, where bsdtar also reads .zip), marks the binary
 * executable, and verifies `tectonic --version` actually runs before moving
 * it into place.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

export const TECTONIC_VERSION = "0.15.0";

/** Release-asset target triples per Node platform-arch, in fallback order.
 *  linux-x64 prefers the gnu build and falls back to the static musl one;
 *  linux-arm64 only ships as musl. */
const TRIPLES: Record<string, string[]> = {
  "linux-x64": ["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"],
  "linux-arm64": ["aarch64-unknown-linux-musl"],
  "darwin-x64": ["x86_64-apple-darwin"],
  "darwin-arm64": ["aarch64-apple-darwin"],
  "win32-x64": ["x86_64-pc-windows-msvc"],
};

function assetName(triple: string): string {
  const ext = triple.includes("windows") ? "zip" : "tar.gz";
  return `tectonic-${TECTONIC_VERSION}-${triple}.${ext}`;
}

/** All download candidates for a platform/arch, in order of preference. */
export function tectonicAssetCandidates(platform: string, arch: string): string[] {
  const triples = TRIPLES[`${platform}-${arch}`] ?? [];
  return triples.map(
    (t) =>
      `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${assetName(t)}`,
  );
}

/** The primary release-asset URL for a platform/arch, or null when unsupported. */
export function tectonicAssetUrl(platform: string, arch: string): string | null {
  return tectonicAssetCandidates(platform, arch)[0] ?? null;
}

/** Find a file by name anywhere under `dir` (release archives may nest). */
function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (entry === name && statSync(p).isFile()) return p;
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

/** The part of fetch the installer uses; tests pass a mock. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

/** The proxy downloads go through: HTTPS_PROXY, then HTTP_PROXY (either case). */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

/** A proxy URL without its credentials, for messages. */
export function redactProxy(proxy: string): string {
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "the configured proxy";
  }
}

/**
 * Node's built-in fetch ignores HTTPS_PROXY (NODE_USE_ENV_PROXY does not
 * exist on Node 22.13). With a proxy configured, use undici's fetch with
 * EnvHttpProxyAgent, which reads the same variables and honors NO_PROXY.
 */
export async function proxyAwareFetch(env: NodeJS.ProcessEnv = process.env): Promise<FetchLike> {
  if (!proxyFromEnv(env)) return (url, init) => fetch(url, init);
  const { fetch: undiciFetch, EnvHttpProxyAgent } = await import("undici");
  const dispatcher = new EnvHttpProxyAgent();
  return (url, init) => undiciFetch(url, { ...init, dispatcher });
}

const RELEASE_API = `https://api.github.com/repos/tectonic-typesetting/tectonic/releases/tags/tectonic%40${TECTONIC_VERSION}`;

/** Asset name → SHA-256 hex from GitHub's release API, or why it could not be read. */
export async function releaseDigests(
  fetchImpl: FetchLike,
  timeoutMs = 15_000,
): Promise<{ digests: Map<string, string> } | { error: string }> {
  try {
    const res = await fetchImpl(RELEASE_API, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "blattbot" },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as { assets?: { name?: unknown; digest?: unknown }[] };
    const digests = new Map<string, string>();
    for (const asset of body.assets ?? []) {
      const hex = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1] : undefined;
      if (typeof asset.name === "string" && hex) digests.set(asset.name, hex.toLowerCase());
    }
    return { digests };
  } catch (err: any) {
    return { error: err?.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : String(err?.message ?? err) };
  }
}

/**
 * Download the first candidate that exists into `workDir` and return its
 * path. Each attempt (request and body) is limited to `timeoutMs`. When
 * GitHub reports a digest for the asset, a mismatch throws and nothing is
 * kept (fail closed); without a digest the download proceeds, unverified.
 */
export async function downloadTectonicArchive(
  candidates: string[],
  workDir: string,
  opts: { fetch?: FetchLike; timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<string> {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const proxy = proxyFromEnv();
  const fetchImpl = opts.fetch ?? (await proxyAwareFetch());
  if (proxy) log(`using proxy ${redactProxy(proxy)}`);

  const release = await releaseDigests(fetchImpl);
  let lastError = "";
  for (const url of candidates) {
    const name = decodeURIComponent(url.split("/").pop()!);
    log(`downloading ${url}`);
    let bytes: Buffer;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        lastError = `${url}: HTTP ${res.status}`;
        continue;
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err: any) {
      lastError =
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `${url}: timed out after ${Math.round(timeoutMs / 1000)} s`
          : `${url}: ${err?.cause?.message ?? err?.message ?? err}`;
      continue;
    }
    const expected = "digests" in release ? release.digests.get(name) : undefined;
    if (expected) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) {
        throw new Error(
          `checksum mismatch for ${name}: GitHub lists sha256 ${expected}, the download has ${actual}. Nothing was installed.`,
        );
      }
      log(`checksum verified (sha256 ${actual.slice(0, 12)}…)`);
    } else {
      const why = "error" in release ? `GitHub's release API: ${release.error}` : "GitHub lists no digest for it";
      log(`checksum not verified (${why})`);
    }
    const archive = join(workDir, name);
    writeFileSync(archive, bytes);
    return archive;
  }
  const hint = proxy
    ? `Check your connection and the proxy (${redactProxy(proxy)})`
    : "Check your connection (behind a proxy? set HTTPS_PROXY)";
  throw new Error(`download failed (${lastError}). ${hint}, or install a TeX engine yourself.`);
}

export async function installTectonic(
  binDir: string,
  opts: {
    platform?: string;
    arch?: string;
    log?: (line: string) => void;
    fetch?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<{ path: string; version: string }> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const log = opts.log ?? (() => {});
  const candidates = tectonicAssetCandidates(platform, arch);
  if (candidates.length === 0) {
    throw new Error(`no prebuilt tectonic for ${platform}/${arch} — install it manually`);
  }

  const work = mkdtempSync(join(tmpdir(), "blattbot-tectonic-"));
  try {
    // The first candidate that exists (gnu → musl fallback on linux).
    const archive = await downloadTectonicArchive(candidates, work, { fetch: opts.fetch, timeoutMs: opts.timeoutMs, log });

    // System tar handles .tar.gz everywhere; on Windows 10+ bsdtar reads .zip too.
    try {
      await execFileP("tar", ["-xf", archive, "-C", work], { timeout: 120_000 });
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new Error("unpacking tectonic needs `tar`, which is not on your PATH");
      throw err;
    }
    rmSync(archive, { force: true });

    const exe = platform === "win32" ? "tectonic.exe" : "tectonic";
    const unpacked = findFile(work, exe);
    if (!unpacked) throw new Error(`archive did not contain ${exe}`);
    chmodSync(unpacked, 0o755);

    // Prove the binary actually runs on this machine before installing it.
    // (tectonic prints its version twice without a separator — normalize.)
    const { stdout } = await execFileP(unpacked, ["--version"], { timeout: 30_000 });
    const versionNumber = stdout.match(/\d+(\.\d+)+/)?.[0];
    const version = versionNumber ? `tectonic ${versionNumber}` : stdout.trim() || "tectonic (version unknown)";

    mkdirSync(binDir, { recursive: true });
    const dest = join(binDir, exe);
    copyFileSync(unpacked, dest); // copy, not rename — the temp dir may be another filesystem
    chmodSync(dest, 0o755);
    log(`installed ${version} → ${dest}`);
    return { path: dest, version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
