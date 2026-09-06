/**
 * runOneShot dispatch: Codex by default, with explicit provider choices
 * honored even when incomplete. The OpenAI path uses a stubbed fetch;
 * Codex's process protocol is covered in codex-backend.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-oneshot-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oneShotBackendId", () => {
  it("defaults to Codex and honors explicit provider choices even when incomplete", async () => {
    const { oneShotBackendId } = await import("../src/agent.js");
    const { DEFAULT_SETTINGS } = await import("../src/settings.js");
    const configured = {
      ...DEFAULT_SETTINGS,
      openaiBaseUrl: "http://127.0.0.1:9999/v1",
      openaiModel: "m1",
    };
    expect(oneShotBackendId({ ...DEFAULT_SETTINGS })).toBe("codex");
    expect(oneShotBackendId(configured)).toBe("codex"); // configured but not active
    expect(oneShotBackendId({ ...configured, backend: "claude" })).toBe("claude");
    expect(oneShotBackendId({ ...configured, backend: "openai" })).toBe("openai");
    // Incomplete configuration must not silently switch providers.
    expect(oneShotBackendId({ ...configured, backend: "openai", openaiModel: "" })).toBe("openai");
    expect(oneShotBackendId({ ...configured, backend: "openai", openaiBaseUrl: " " })).toBe("openai");
  });
});

describe("runOneShot on the openai backend", () => {
  it("makes a single non-streaming, tool-less chat completion", async () => {
    const settings = await import("../src/settings.js");
    settings.saveSettings({
      backend: "openai",
      openaiBaseUrl: "http://127.0.0.1:9999/v1/",
      openaiModel: "test-model",
      openaiApiKey: "sk-mock",
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "  A tidy TL;DR.  " } }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { runOneShot } = await import("../src/agent.js");
    expect(await runOneShot("Summarize this")).toBe("A tidy TL;DR.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-mock");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "Summarize this" }],
      stream: false,
    });
    // No tools on a one-shot call.
    expect(body.tools).toBeUndefined();
  });

  it("throws on HTTP errors and empty responses", async () => {
    const { runOneShotOpenai } = await import("../src/backends/openai.js");
    const { DEFAULT_SETTINGS } = await import("../src/settings.js");
    const s = {
      ...DEFAULT_SETTINGS,
      backend: "openai" as const,
      openaiBaseUrl: "http://127.0.0.1:9999/v1",
      openaiModel: "m1",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "kaboom" })),
    );
    await expect(runOneShotOpenai("hi", s)).rejects.toThrow(/HTTP 500.*kaboom/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) })),
    );
    await expect(runOneShotOpenai("hi", s)).rejects.toThrow(/no text/);

    // Unconfigured setups fail fast without a request.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(runOneShotOpenai("hi", { ...s, openaiBaseUrl: "" })).rejects.toThrow(/base URL/);
    await expect(runOneShotOpenai("hi", { ...s, openaiModel: "" })).rejects.toThrow(/model/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
