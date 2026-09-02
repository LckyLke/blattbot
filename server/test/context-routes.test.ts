/**
 * HTTP coverage of the folder picker and the context-link route it feeds:
 * browsing walks the machine, so the auth gate and the credential exclusions
 * are asserted here, not only in the unit tests for browseDirectories. Boots
 * the real server in-process against an isolated data dir.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_PORT = 4664;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

describe("context routes", () => {
  let dataDir: string;
  let repo: string;
  let app: import("fastify").FastifyInstance;
  let token: string;
  let projectId: string;

  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${SERVER_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-context-routes-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.stubEnv("BLATTBOT_PORT", String(SERVER_PORT));
    vi.resetModules();
    ({ app } = await import("../src/index.js"));

    // A stand-in codebase to link, outside the data dir.
    repo = mkdtempSync(join(tmpdir(), "blattbot-context-repo-"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "model.py"), "def loss(): ...\n");

    const boot = await fetch(`${SERVER_BASE}/api/bootstrap`);
    token = ((await boot.json()) as { token: string }).token;
    const created = await call("/api/projects", { method: "POST", body: { local: true, name: "Context" } });
    expect(created.status).toBe(200);
    projectId = ((await created.json()) as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    for (const d of [dataDir, repo]) {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("browses from the home directory by default and into a given folder", async () => {
    const home = (await (await call("/api/fs/dirs")).json()) as { path: string };
    expect(home.path).toBe(homedir());

    const res = await call(`/api/fs/dirs?path=${encodeURIComponent(repo)}`);
    expect(res.status).toBe(200);
    const listing = (await res.json()) as {
      path: string;
      parent: string | null;
      entries: { name: string; path: string }[];
    };
    expect(listing.path).toBe(repo);
    expect(listing.parent).not.toBeNull();
    expect(listing.entries).toEqual([{ name: "src", path: join(repo, "src") }]);
  });

  it("needs the local token, like every other API route — it walks the whole machine", async () => {
    const res = await fetch(`${SERVER_BASE}/api/fs/dirs?path=${encodeURIComponent(repo)}`);
    expect(res.status).toBe(401);
  });

  it("answers 400 for a missing folder and for BlattBot's own data", async () => {
    const missing = await call(`/api/fs/dirs?path=${encodeURIComponent(join(repo, "nope"))}`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/no such folder/);

    const chats = join(dataDir, "chats");
    mkdirSync(chats, { recursive: true });
    const secret = await call(`/api/fs/dirs?path=${encodeURIComponent(chats)}`);
    expect(secret.status).toBe(400);
    expect(((await secret.json()) as { error: string }).error).toMatch(/credentials/);
  });

  it("links a browsed folder and reports it as a directory", async () => {
    const res = await call(`/api/projects/${projectId}/context/link`, {
      method: "POST",
      body: { path: repo },
    });
    expect(res.status).toBe(200);
    const ctx = (await res.json()) as { links: { path: string; kind: string; exists: boolean }[] };
    expect(ctx.links).toEqual([{ path: repo, kind: "dir", exists: true }]);
  });
});
