import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git.js";

const SERVER_PORT = 4660;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

describe("compile-rev (approval-base build cache)", () => {
  let dataDir: string;
  let app: import("fastify").FastifyInstance;
  let token: string;
  let projectId: string;
  let projDir: string;
  /** The fake engine appends one line per run — the recompile counter. */
  let countFile: string;

  const compileRuns = () => {
    try {
      return readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  const revDirs = () =>
    readdirSync(join(dataDir, "builds", projectId)).filter((f) => f.startsWith("rev-"));

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

  const compileHead = async () => {
    const res = await call(`/api/projects/${projectId}/compile-rev`, {
      method: "POST",
      body: { rev: "HEAD" },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { ok: boolean; sha: string; log?: string };
  };

  beforeAll(async () => {
    // Isolated data dir with a FAKE tectonic in BIN_DIR (checked before PATH),
    // so compiles are instant and hermetic: it writes a minimal %PDF that
    // EMBEDS the source it compiled (so tests can tell WHICH tree was built)
    // and bumps a counter file — the "did it actually recompile?" probe.
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-compilerev-"));
    countFile = join(dataDir, "compile-count");
    mkdirSync(join(dataDir, "bin"), { recursive: true });
    writeFileSync(
      join(dataDir, "bin", "tectonic"),
      [
        "#!/bin/sh",
        'out="$2"', // args: --outdir <out> --keep-logs --chatter minimal <main>
        'for a in "$@"; do main="$a"; done',
        '{ printf "%%PDF-1.4 fake\\n"; cat "$main"; } > "$out/$(basename "$main" .tex).pdf"',
        `echo run >> "${countFile}"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // Boot the real server in-process; index.ts listens at import time, so
    // the env must be stubbed before the import.
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.stubEnv("BLATTBOT_PORT", String(SERVER_PORT));
    vi.resetModules();
    ({ app } = await import("../src/index.js"));
    const boot = await fetch(`${SERVER_BASE}/api/bootstrap`);
    token = ((await boot.json()) as { token: string }).token;

    const created = await call("/api/projects", {
      method: "POST",
      body: { local: true, name: "Rev Cache Test" },
    });
    expect(created.status).toBe(200);
    projectId = ((await created.json()) as { id: string }).id;
    projDir = join(dataDir, "projects", projectId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("compiles HEAD into a per-sha cache and serves it via ?rev=<sha>", async () => {
    const r = await compileHead();
    expect(r.ok).toBe(true);
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(compileRuns()).toBe(1);

    const pdf = await call(`/api/projects/${projectId}/pdf?rev=${r.sha}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.toString("latin1", 0, 4)).toBe("%PDF");
  });

  it("a second compile of the same sha is a cache hit — no engine run", async () => {
    const before = compileRuns();
    const r = await compileHead();
    expect(r.ok).toBe(true);
    expect(compileRuns()).toBe(before);
  });

  it("rejects revs other than HEAD", async () => {
    const res = await call(`/api/projects/${projectId}/compile-rev`, {
      method: "POST",
      body: { rev: "HEAD~1" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("HEAD");
  });

  it("?rev validates the sha and 404s on uncompiled revisions", async () => {
    const bad = await call(`/api/projects/${projectId}/pdf?rev=..%2F..%2Fetc`);
    expect(bad.status).toBe(400);
    const unknown = await call(`/api/projects/${projectId}/pdf?rev=${"d".repeat(40)}`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toContain("compile it first");
  });

  it("a new commit gets its own cache; old caches evict beyond the 3 newest", async () => {
    const first = await compileHead();
    const shas = [first.sha];
    // Four more commits, each compiled: 5 shas total, only 3 caches may stay.
    for (let i = 0; i < 4; i++) {
      // mtime granularity guard so eviction's newest-first order is stable.
      await new Promise((r) => setTimeout(r, 30));
      appendFileSync(join(projDir, "main.tex"), `% rev tweak ${i}\n`);
      await git.commitAll(projDir, `tweak ${i}`);
      const r = await compileHead();
      expect(r.ok).toBe(true);
      expect(r.sha).not.toBe(shas[shas.length - 1]);
      shas.push(r.sha);
    }
    expect(compileRuns()).toBeGreaterThanOrEqual(5);

    const kept = revDirs();
    expect(kept.length).toBe(3);
    expect(kept.sort()).toEqual(
      shas
        .slice(-3)
        .map((s) => `rev-${s}`)
        .sort(),
    );

    // The evicted sha 404s again; the newest still serves.
    const gone = await call(`/api/projects/${projectId}/pdf?rev=${shas[0]}`);
    expect(gone.status).toBe(404);
    const fresh = await call(`/api/projects/${projectId}/pdf?rev=${shas[shas.length - 1]}`);
    expect(fresh.status).toBe(200);
  });

  it("compiles the tree AS COMMITTED at the rev — never the dirty working copy", async () => {
    appendFileSync(join(projDir, "main.tex"), "% COMMITTED-MARKER\n");
    await git.commitAll(projDir, "marker commit");
    // Pending unapproved drift the approval-base build must NOT see — a build
    // of the working copy would make the rendered diff report falsely clean.
    appendFileSync(join(projDir, "main.tex"), "% DIRTY-MARKER\n");

    const r = await compileHead();
    expect(r.ok).toBe(true);
    const pdf = await call(`/api/projects/${projectId}/pdf?rev=${r.sha}`);
    expect(pdf.status).toBe(200);
    const body = Buffer.from(await pdf.arrayBuffer()).toString("utf8");
    expect(body).toContain("% COMMITTED-MARKER");
    expect(body).not.toContain("% DIRTY-MARKER");
  });
});
