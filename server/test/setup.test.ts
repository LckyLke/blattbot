import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TECTONIC_VERSION,
  downloadTectonicArchive,
  proxyAwareFetch,
  proxyFromEnv,
  redactProxy,
  tectonicAssetCandidates,
  tectonicAssetUrl,
  type FetchLike,
} from "../src/setup.js";

const BASE = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}`;

describe("tectonicAssetUrl", () => {
  it("linux x64 prefers the gnu build", () => {
    expect(tectonicAssetUrl("linux", "x64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    );
  });

  it("linux x64 falls back to musl", () => {
    expect(tectonicAssetCandidates("linux", "x64")).toEqual([
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    ]);
  });

  it("linux arm64 only ships as musl", () => {
    expect(tectonicAssetCandidates("linux", "arm64")).toEqual([
      `${BASE}/tectonic-${TECTONIC_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    ]);
  });

  it("macOS covers both architectures", () => {
    expect(tectonicAssetUrl("darwin", "x64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-apple-darwin.tar.gz`,
    );
    expect(tectonicAssetUrl("darwin", "arm64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-aarch64-apple-darwin.tar.gz`,
    );
  });

  it("windows x64 is a zip (msvc build)", () => {
    expect(tectonicAssetUrl("win32", "x64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`,
    );
  });

  it("unsupported platforms return null / empty", () => {
    expect(tectonicAssetUrl("freebsd", "x64")).toBeNull();
    expect(tectonicAssetUrl("win32", "arm64")).toBeNull();
    expect(tectonicAssetCandidates("aix", "ppc64")).toEqual([]);
  });
});

// ---- download: timeout, proxy, checksum ------------------------------------

const [GNU, MUSL] = tectonicAssetCandidates("linux", "x64");
const nameOf = (url: string) => decodeURIComponent(url.split("/").pop()!);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ARCHIVE = Buffer.from("pretend this is a tectonic tarball");
const isApi = (url: string) => url.startsWith("https://api.github.com/");
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/** A fetch serving fixed routes; `api` answers GitHub's release API. */
function mockFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const route = isApi(url) ? routes.api : routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}
const apiWith = (digests: Record<string, string | null>) => () =>
  Response.json({ assets: Object.entries(digests).map(([name, digest]) => ({ name, digest })) });

describe("downloadTectonicArchive", () => {
  let work: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "blattbot-setup-test-"));
    lines = [];
    // The host may have a proxy configured; these tests inject fetch.
    for (const key of PROXY_VARS) vi.stubEnv(key, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(work, { recursive: true, force: true });
  });

  it("keeps the archive when it matches GitHub's SHA-256 digest", async () => {
    const { fetch } = mockFetch({
      api: apiWith({ [nameOf(GNU)]: `sha256:${sha256(ARCHIVE)}` }),
      [GNU]: () => new Response(ARCHIVE),
    });
    const archive = await downloadTectonicArchive([GNU, MUSL], work, { fetch, log });
    expect(archive).toBe(join(work, nameOf(GNU)));
    expect(readFileSync(archive)).toEqual(ARCHIVE);
    expect(lines.some((l) => l.startsWith("checksum verified"))).toBe(true);
  });

  it("fails closed on a digest mismatch: throws, keeps nothing, tries no other build", async () => {
    const { fetch, calls } = mockFetch({
      api: apiWith({ [nameOf(GNU)]: `sha256:${"0".repeat(64)}` }),
      [GNU]: () => new Response(ARCHIVE),
      [MUSL]: () => new Response(ARCHIVE),
    });
    await expect(downloadTectonicArchive([GNU, MUSL], work, { fetch, log })).rejects.toThrow(
      /checksum mismatch for tectonic-.*Nothing was installed/,
    );
    expect(readdirSync(work)).toEqual([]);
    expect(calls).not.toContain(MUSL);
  });

  it("proceeds unverified when the release API is unavailable", async () => {
    const { fetch } = mockFetch({
      api: () => new Response("rate limited", { status: 403 }),
      [GNU]: () => new Response(ARCHIVE),
    });
    const archive = await downloadTectonicArchive([GNU], work, { fetch, log });
    expect(readFileSync(archive)).toEqual(ARCHIVE);
    expect(lines).toContain("checksum not verified (GitHub's release API: HTTP 403)");
  });

  it("proceeds unverified when the release API cannot be reached", async () => {
    const fetch: FetchLike = async (url) => {
      if (isApi(url)) throw new TypeError("fetch failed");
      return new Response(ARCHIVE);
    };
    await downloadTectonicArchive([GNU], work, { fetch, log });
    expect(lines).toContain("checksum not verified (GitHub's release API: fetch failed)");
  });

  it("proceeds unverified when the API lists no digest for the asset", async () => {
    const { fetch } = mockFetch({ api: apiWith({ [nameOf(GNU)]: null }), [GNU]: () => new Response(ARCHIVE) });
    await downloadTectonicArchive([GNU], work, { fetch, log });
    expect(lines).toContain("checksum not verified (GitHub lists no digest for it)");
  });

  it("falls back to the next candidate and checks that asset's digest", async () => {
    const { fetch, calls } = mockFetch({
      api: apiWith({ [nameOf(MUSL)]: `sha256:${sha256(ARCHIVE)}` }),
      [MUSL]: () => new Response(ARCHIVE),
    });
    const archive = await downloadTectonicArchive([GNU, MUSL], work, { fetch, log });
    expect(archive).toBe(join(work, nameOf(MUSL)));
    expect(calls.filter((c) => !isApi(c))).toEqual([GNU, MUSL]);
    expect(lines.some((l) => l.startsWith("checksum verified"))).toBe(true);
  });

  it("times out a stalled download with a clear error", async () => {
    const stalled: FetchLike = (url, init) =>
      isApi(url)
        ? Promise.resolve(new Response("{}", { status: 500 }))
        : new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    await expect(downloadTectonicArchive([GNU], work, { fetch: stalled, timeoutMs: 50, log })).rejects.toThrow(
      /download failed \(.*timed out after 0 s\)\. Check your connection \(behind a proxy\? set HTTPS_PROXY\)/,
    );
    expect(readdirSync(work)).toEqual([]);
  });

  it("names the proxy, without its credentials, when the download fails", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://user:secret@proxy.example:3128");
    const { fetch } = mockFetch({});
    const error = await downloadTectonicArchive([GNU], work, { fetch, log }).catch((e: Error) => e);
    expect(String(error)).toMatch(/HTTP 404\)\. Check your connection and the proxy \(http:\/\/proxy\.example:3128\)/);
    expect(`${error}\n${lines.join("\n")}`).not.toContain("secret");
  });
});

describe("proxy support", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers HTTPS_PROXY, then HTTP_PROXY, in either case", () => {
    expect(proxyFromEnv({})).toBeNull();
    expect(proxyFromEnv({ https_proxy: " " })).toBeNull();
    expect(proxyFromEnv({ http_proxy: "http://h:1" })).toBe("http://h:1");
    expect(proxyFromEnv({ HTTP_PROXY: "http://h:1", https_proxy: "http://s:2" })).toBe("http://s:2");
    expect(proxyFromEnv({ HTTPS_PROXY: "http://S:3", https_proxy: "http://s:2" })).toBe("http://S:3");
    expect(redactProxy("http://user:pw@proxy:8080/")).toBe("http://proxy:8080");
    expect(redactProxy("not a url")).toBe("the configured proxy");
  });

  it("sends requests through the configured proxy (Node's own fetch ignores it)", async () => {
    const seen: string[] = [];
    const proxy = createServer((req, res) => {
      seen.push(req.url ?? ""); // forward mode: the absolute URL
      res.end("via proxy");
    });
    // Tunnel mode (undici's default): answer the tunnelled request ourselves.
    proxy.on("connect", (req, socket) => {
      seen.push(req.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia proxy"));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      for (const key of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(key, "");
      vi.stubEnv("HTTP_PROXY", proxyUrl);
      vi.stubEnv("http_proxy", proxyUrl);
      const viaProxy = await proxyAwareFetch();
      const res = await viaProxy("http://tectonic.invalid/asset.tar.gz", { signal: AbortSignal.timeout(10_000) });
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("via proxy");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^(http:\/\/)?tectonic\.invalid(:80)?(\/asset\.tar\.gz)?$/);
    } finally {
      proxy.close();
    }
  });

  it("uses Node's own fetch when no proxy is set", async () => {
    for (const key of PROXY_VARS) vi.stubEnv(key, "");
    const stub = vi.fn(async () => new Response("direct"));
    vi.stubGlobal("fetch", stub);
    try {
      const direct = await proxyAwareFetch();
      await direct("https://example.invalid/", { signal: AbortSignal.timeout(1000) });
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
