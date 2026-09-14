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
