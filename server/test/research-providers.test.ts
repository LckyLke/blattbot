import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "blattbot-providers-")); vi.stubEnv("BLATTBOT_DATA_DIR", root); vi.stubEnv("OPENALEX_API_KEY", ""); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
describe("research provider transport", () => {
  it("serializes concurrent search and paper requests under the same key quota", async () => {
    vi.useFakeTimers();
    const { saveSettings } = await import("../src/settings.js"); saveSettings({ s2ApiKey: "fixture-private-key" });
    const { semanticScholarGet } = await import("../src/research-providers.js");
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { times.push(Date.now()); expect(init.headers["x-api-key"]).toBe("fixture-private-key"); return json({ title: "Paper" }); }));
    const calls = Promise.all([semanticScholarGet("/paper/1"), semanticScholarGet("/paper/search?query=graph"), semanticScholarGet("/paper/2")]);
    await vi.advanceTimersByTimeAsync(3300); await calls;
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1100);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1100);
    await semanticScholarGet("/paper/1"); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("caches batch identities separately and shares pacing with searches", async () => {
    vi.useFakeTimers();
    const { saveSettings } = await import("../src/settings.js"); saveSettings({ s2ApiKey: "fixture-private-key" });
    const { semanticScholarPaperBatch, semanticScholarGet } = await import("../src/research-providers.js");
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      times.push(Date.now());
      if (String(url).includes("/batch")) {
        expect(init?.method).toBe("POST");
        const ids = JSON.parse(String(init?.body)).ids;
        return json(ids.map((id: string) => id === "missing" ? null : { title: id }));
      }
      return json({ data: [] });
    }));
    expect(await semanticScholarPaperBatch(["a", "missing"], "title")).toEqual([{ title: "a" }, null]);
    await semanticScholarPaperBatch(["a", "missing"], "title");
    const calls = Promise.all([semanticScholarPaperBatch(["b"], "title"), semanticScholarGet("/paper/search?query=b")]);
    await vi.advanceTimersByTimeAsync(2300);
    expect((await calls)[0]).toEqual([{ title: "b" }]);
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1100);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1100);
  });
  it("does not cache a malformed batch as paper metadata", async () => {
    const { semanticScholarPaperBatch } = await import("../src/research-providers.js");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Bad response" })));
    await expect(semanticScholarPaperBatch(["a"], "title")).rejects.toThrow("invalid paper batch");
    vi.mocked(fetch).mockResolvedValue(json([{ title: "Paper A" }]));
    expect(await semanticScholarPaperBatch(["a"], "title")).toEqual([{ title: "Paper A" }]);
  });
  it("shares Retry-After cooldown and describes a configured key accurately", async () => {
    vi.useFakeTimers();
    const { saveSettings } = await import("../src/settings.js"); saveSettings({ s2ApiKey: "fixture-private-key" });
    const { semanticScholarGet } = await import("../src/research-providers.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "90" } })));
    await expect(semanticScholarGet("/paper/1")).rejects.toThrow("saved API key was sent");
    await expect(semanticScholarGet("/paper/2")).rejects.toMatchObject({ keyConfigured: true, retryAt: Date.now() + 90_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValue(json({ title: "Paper" }));
    await vi.advanceTimersByTimeAsync(90_001);
    await semanticScholarGet("/paper/2"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not send a queued request after cancellation", async () => {
    vi.useFakeTimers();
    const { saveSettings } = await import("../src/settings.js"); saveSettings({ s2ApiKey: "fixture-private-key" });
    const { semanticScholarGet } = await import("../src/research-providers.js");
    vi.stubGlobal("fetch", vi.fn(async () => json({ title: "Paper" })));
    await semanticScholarGet("/paper/1");
    const controller = new AbortController();
    const pending = semanticScholarGet("/paper/2", { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100); controller.abort(); await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["seconds", "date", "absent"])("recovers authenticated throttling with a %s Retry-After", async (header) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T10:00:00Z"));
    const { saveSettings } = await import("../src/settings.js");
    saveSettings({ s2ApiKey: "fixture-private-key" });
    const { semanticScholarGet, researchProviderRetryAt } = await import("../src/research-providers.js");
    const times: number[] = [];
    const retryAfter = header === "seconds" ? "2" : header === "date" ? new Date(Date.now() + 2000).toUTCString() : undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      times.push(Date.now());
      expect(init?.headers["x-api-key"]).toBe("fixture-private-key");
      return times.length === 1
        ? new Response("", { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} })
        : json({ title: "Recovered paper" });
    }));
    const pending = semanticScholarGet("/paper/1");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ title: "Recovered paper" });
    expect(times[1] - times[0]).toBe(2000);
    expect(researchProviderRetryAt()).toBeLessThanOrEqual(Date.now());
  });
  it("bounds repeated throttling and shares its cooldown with queued callers", async () => {
    vi.useFakeTimers();
    const { saveSettings } = await import("../src/settings.js");
    saveSettings({ s2ApiKey: "fixture-private-key" });
    const { semanticScholarGet } = await import("../src/research-providers.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    const assertion = expect(semanticScholarGet("/paper/1")).rejects.toMatchObject({ keyConfigured: true });
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.mocked(fetch).mockResolvedValue(json({ title: "Recovered paper" }));
    const next = semanticScholarGet("/paper/2");
    await vi.advanceTimersByTimeAsync(7999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toEqual({ title: "Recovered paper" });
  });
  it("cancels during Retry-After without sending another request", async () => {
    vi.useFakeTimers();
    const { saveSettings } = await import("../src/settings.js");
    saveSettings({ s2ApiKey: "fixture-private-key" });
    const { semanticScholarGet } = await import("../src/research-providers.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "2" } })));
    const controller = new AbortController();
    const assertion = expect(semanticScholarGet("/paper/1", { signal: controller.signal })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses a key saved while a request was queued, without inheriting the anonymous cooldown", async () => {
    const { saveSettings } = await import("../src/settings.js");
    const { semanticScholarGet } = await import("../src/research-providers.js");
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValue(json({ title: "Paper" })));
    const first = expect(semanticScholarGet("/paper/1")).rejects.toMatchObject({ keyConfigured: false });
    await Promise.resolve();
    const queued = semanticScholarGet("/paper/2");
    saveSettings({ s2ApiKey: "new-key" });
    finish(new Response("", { status: 429, headers: { "Retry-After": "90" } }));
    await first;
    expect(await queued).toEqual({ title: "Paper" });
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).not.toHaveProperty("x-api-key");
    expect(vi.mocked(fetch).mock.calls[1][1]?.headers).toMatchObject({ "x-api-key": "new-key" });
  });
  it("caches explicit paper title resolution but keeps literature searches fresh", async () => {
    vi.useFakeTimers();
    const { semanticScholarGet } = await import("../src/research-providers.js");
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ title: "Paper" }] })));
    const path = "/paper/search?query=Paper";
    await Promise.all([semanticScholarGet(path, { cache: true }), semanticScholarGet(path, { cache: true })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await semanticScholarGet(path);
    await semanticScholarGet(path);
    expect(fetch).toHaveBeenCalledTimes(3);
    await semanticScholarGet(path, { cache: true, fresh: true });
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(300_001);
    await semanticScholarGet(path, { cache: true });
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("keeps keys out of public settings and applies OpenAlex auth only to OpenAlex", async () => {
    const { saveSettings, publicSettings } = await import("../src/settings.js");
    saveSettings({ s2ApiKey: "secret-s2", openAlexApiKey: "secret-alex" });
    const publicValue = publicSettings();
    expect(publicValue).toMatchObject({ hasS2ApiKey: true, hasOpenAlexApiKey: true });
    expect(JSON.stringify(publicValue)).not.toContain("secret-");
    const { fetchJson } = await import("../src/research/discovery.js");
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    await fetchJson("https://api.openalex.org/works/W1");
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer secret-alex" });
    await fetchJson("https://api.crossref.org/works/1");
    expect(vi.mocked(fetch).mock.calls[1][1]?.headers).not.toHaveProperty("Authorization");
  });
  it("uses Unpaywall only with explicit contact configuration and matching DOI", async () => {
    const { saveSettings } = await import("../src/settings.js");
    const { unpaywallPdfUrls } = await import("../src/research-providers.js");
    vi.stubGlobal("fetch", vi.fn(async () => json({ doi: "10.1234/test", oa_locations: [{ url_for_pdf: "https://repository.example/paper.pdf" }] })));
    expect(await unpaywallPdfUrls("10.1234/test")).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    saveSettings({ unpaywallEmail: "researcher@example.org" });
    expect(await unpaywallPdfUrls("10.1234/test")).toEqual(["https://repository.example/paper.pdf"]);
    expect(await unpaywallPdfUrls("10.1234/different")).toEqual([]);
  });
});
