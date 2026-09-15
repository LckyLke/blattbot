import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { fetchPublicUrl, htmlText, publicAddress, readUrl, repositoryUrl } from "../src/read-url.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request: vi.fn() }));

const signal = () => new AbortController().signal;
function response(body: string, type = "text/plain", url = "https://example.com/code.ts") {
  return { url, type, body: Buffer.from(body) };
}
function mockResponse(status: number, headers: Record<string, string>, body = "") {
  vi.mocked(request).mockImplementationOnce(((_url: URL, _options: unknown, callback: any) => {
    const req = new EventEmitter() as any;
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough() as any;
      res.statusCode = status;
      res.headers = headers;
      callback(res);
      if (!res.destroyed) res.end(body);
    });
    return req;
  }) as any);
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any); });

describe("public URL transport", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"])("rejects local address %s", address => {
    expect(publicAddress(address)).toBe(false);
  });
  it("accepts public IPv4 and IPv6", () => {
    expect(publicAddress("93.184.216.34")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects non-HTTP URLs, credentials, and private DNS before connecting", async () => {
    await expect(fetchPublicUrl("file:///etc/passwd", signal())).rejects.toThrow("HTTP");
    await expect(fetchPublicUrl("https://user:secret@example.com", signal())).rejects.toThrow("credentials");
    vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
    await expect(fetchPublicUrl("https://example.com", signal())).rejects.toThrow("private");
    expect(request).not.toHaveBeenCalled();
  });
  it("checks redirects again and pins connections without forwarding credentials", async () => {
    mockResponse(302, { location: "http://127.0.0.1/admin" });
    await expect(fetchPublicUrl("https://example.com", signal())).rejects.toThrow("private");
    expect(request).toHaveBeenCalledTimes(1);
    const options = vi.mocked(request).mock.calls[0][1] as any;
    expect(options.headers).not.toHaveProperty("Cookie");
    expect(options.headers).not.toHaveProperty("Authorization");
    const resolved = vi.fn();
    options.lookup("example.com", { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });
  it("follows public redirects and reports HTTP failures", async () => {
    mockResponse(301, { location: "/raw/file.py" });
    mockResponse(200, { "content-type": "text/plain" }, "print('hello')");
    expect(await fetchPublicUrl("https://example.com/file", signal())).toMatchObject({ url: "https://example.com/raw/file.py", body: Buffer.from("print('hello')") });
    mockResponse(403, {});
    await expect(fetchPublicUrl("https://example.com/private", signal())).rejects.toThrow("HTTP 403");
  });
  it("bounds response size and respects an already aborted turn", async () => {
    mockResponse(200, {}, "x".repeat(4 * 1024 * 1024 + 1));
    await expect(fetchPublicUrl("https://example.com", signal())).rejects.toThrow("4 MiB");
    const controller = new AbortController(); controller.abort();
    await expect(fetchPublicUrl("https://example.com", controller.signal)).rejects.toThrow();
  });
});

describe("URL source reading", () => {
  it("preserves code and returns recoverable pagination on arbitrary hosts", async () => {
    const content = "const x = '<tag>';\nexport { x };";
    const fetcher = vi.fn(async (_url: string, _signal: AbortSignal) => response(content));
    const first = await readUrl({ url: "https://code.example.org/file.ts", limit: 12 }, signal(), fetcher);
    const second = await readUrl({ url: "https://code.example.org/file.ts", offset: first.nextOffset }, signal(), fetcher);
    expect(first.content + second.content).toBe(content);
    expect(second.nextOffset).toBeNull();
    expect(fetcher.mock.calls[0][0]).toBe("https://code.example.org/file.ts");
  });
  it("extracts page text and followable links without scripts", () => {
    const text = htmlText('<h1>Docs &amp; code</h1><script>secretScript()</script><p>Read <a href="../raw/a.ts">source</a>.</p>', "https://example.org/docs/start");
    expect(text).toContain("Docs & code");
    expect(text).toContain("source (https://example.org/raw/a.ts)");
    expect(text).not.toContain("secretScript");
  });
  it("maps GitHub roots, directories and files while keeping other hosts intact", () => {
    expect(repositoryUrl("https://github.com/team/project")).toBe("https://api.github.com/repos/team/project/contents/");
    expect(repositoryUrl("https://github.com/team/project/tree/main/src")).toBe("https://api.github.com/repos/team/project/contents/src?ref=main");
    expect(repositoryUrl("https://github.com/team/project/blob/main/src/a.ts")).toBe("https://api.github.com/repos/team/project/contents/src/a.ts?ref=main");
    expect(repositoryUrl("https://gitlab.com/team/project")).toBe("https://gitlab.com/team/project");
  });
  it("provides navigable repository listings and decoded file contents", async () => {
    const url = "https://api.github.com/repos/team/project/contents/";
    const listing = await readUrl({ url: "https://github.com/team/project" }, signal(), async () => response(JSON.stringify([{ type: "file", path: "README.md", url: url + "README.md" }]), "application/json", url));
    expect(listing).toMatchObject({ format: "repository-directory", content: `file README.md\n${url}README.md` });
    const file = await readUrl({ url: url + "README.md" }, signal(), async () => response(JSON.stringify({ encoding: "base64", content: Buffer.from("# Read me").toString("base64") }), "application/json", url + "README.md"));
    expect(file).toMatchObject({ format: "repository-file", content: "# Read me" });
  });
  it("reports binary content instead of claiming to have read it", async () => {
    await expect(readUrl({ url: "https://example.com/archive" }, signal(), async () => response("PK\0\0"))).rejects.toThrow("binary");
  });
  it("exposes URL reading in read-only and Codex catalogs", async () => {
    const { toolDefinitions } = await import("../src/backends/openai.js");
    const { codexTools } = await import("../src/backends/codex.js");
    expect(toolDefinitions(true).some(t => t.function.name === "read_url")).toBe(true);
    expect(codexTools().some(t => t.name === "read_url")).toBe(true);
  });
});
