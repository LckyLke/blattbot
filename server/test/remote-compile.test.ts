import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";
import { OverleafClient } from "../src/overleaf/olclient.js";

const MOCK_PORT = 4658;
const SERVER_PORT = 4659;
const REMOTE_ID = "aaaa2222bbbb3333cccc4444";
const COOKIE = "overleaf_session2=mock-session";
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

const MAIN = "\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n";

describe("verify on Overleaf (remote compile)", () => {
  let mock: MockOverleaf;
  let dataDir: string;
  let app: import("fastify").FastifyInstance;
  let token: string;
  /** The imported cookie-mode project's BlattBot id. */
  let projectId: string;
  /** A kind "local" project — remote compile must refuse it. */
  let localId: string;

  /** Authorized call against the booted BlattBot server. */
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${SERVER_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        // Fastify rejects empty-body POSTs that carry a JSON content-type.
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  beforeAll(async () => {
    mock = await startMockOverleaf(MOCK_PORT, REMOTE_ID);
    mock.files.set("main.tex", Buffer.from(MAIN));

    // Boot the real server in-process against an isolated data dir; index.ts
    // listens at import time, so the env must be stubbed before the import.
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-remotecompile-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.stubEnv("BLATTBOT_PORT", String(SERVER_PORT));
    vi.resetModules();
    ({ app } = await import("../src/index.js"));
    const boot = await fetch(`${SERVER_BASE}/api/bootstrap`);
    token = ((await boot.json()) as { token: string }).token;

    const created = await call("/api/projects", {
      method: "POST",
      body: { url: `${MOCK_BASE}/project/${REMOTE_ID}`, cookie: COOKIE },
    });
    expect(created.status).toBe(200);
    projectId = ((await created.json()) as { id: string }).id;

    const local = await call("/api/projects", {
      method: "POST",
      body: { local: true, name: "Plain Local" },
    });
    expect(local.status).toBe(200);
    localId = ((await local.json()) as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await mock.close();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("client compileProject returns the PDF bytes on success", async () => {
    const client = new OverleafClient(MOCK_BASE, COOKIE);
    const r = await client.compileProject(REMOTE_ID);
    expect(r.status).toBe("success");
    expect(r.pdf?.toString("latin1", 0, 4)).toBe("%PDF");
    expect(r.logTail).toBeUndefined();
  });

  it("client compileProject returns the log tail on failure", async () => {
    mock.failCompile = true;
    try {
      const client = new OverleafClient(MOCK_BASE, COOKIE);
      const r = await client.compileProject(REMOTE_ID);
      expect(r.status).toBe("failure");
      expect(r.pdf).toBeUndefined();
      expect(r.logTail).toContain("Undefined control sequence");
    } finally {
      mock.failCompile = false;
    }
  });

  it("route compiles remotely and serves the PDF via ?source=remote", async () => {
    const res = await call(`/api/projects/${projectId}/remote-compile`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "success", pdf: true });

    const pdf = await call(`/api/projects/${projectId}/pdf?source=remote`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.toString("latin1", 0, 4)).toBe("%PDF");
  });

  it("route reports a failed remote build as a 200 result with the log", async () => {
    mock.failCompile = true;
    try {
      const res = await call(`/api/projects/${projectId}/remote-compile`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; pdf: boolean; logTail: string };
      expect(body.status).toBe("failure");
      expect(body.pdf).toBe(false);
      expect(body.logTail).toContain("Undefined control sequence");
    } finally {
      mock.failCompile = false;
    }
  });

  it("route rejects non-Overleaf projects", async () => {
    const res = await call(`/api/projects/${localId}/remote-compile`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/overleaf/i);
  });

  it("?source=remote 404s before any remote build exists", async () => {
    const res = await call(`/api/projects/${localId}/pdf?source=remote`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Verify on Overleaf");
  });
});
