import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textPdf } from "./fixtures/pdf.js";
const port = 4668;
const base = `http://127.0.0.1:${port}`;
describe("research HTTP workspace", () => {
  let root: string,
    app: import("fastify").FastifyInstance,
    id: string,
    dir: string,
    token: string;
  const call = (suffix: string, body?: unknown, method = "POST") =>
    fetch(`${base}/api/projects/${id}/research${suffix}`, {
      method: body === undefined ? "GET" : method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "blattbot-research-http-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", root);
    vi.stubEnv("BLATTBOT_PORT", String(port));
    vi.resetModules();
    ({ app } = await import("../src/index.js"));
    token = ((await (await fetch(`${base}/api/bootstrap`)).json()) as any)
      .token;
    const cfg = await import("../src/config.js");
    id = cfg.addProject({ name: "Research", gitUrl: "", kind: "local" }).id;
    dir = cfg.projectDir(id);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "refs.bib"),
      "@article{alpha,title={Graph Models},author={Ada Smith},year={2020}}",
    );
    writeFileSync(join(dir, "main.tex"), "A graph claim~\\cite{alpha}.");
    writeFileSync(
      join(dir, "alpha.pdf"),
      textPdf(["Graph Models. Actual paper text."]),
    );
  }, 60000);
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  it("protects the workspace, queries and page images with existing API authentication", async () => {
    for (const suffix of ["", "/graph", "/page-image/alpha/1"])
      expect(
        (await fetch(`${base}/api/projects/${id}/research${suffix}`)).status,
      ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/projects/unknown/research`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    const res = await call("");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.library.sources).toHaveLength(1);
    expect(data.jobs).toBeDefined();
    expect(data.evidence).toBeUndefined();
    expect(data.memory).toBeUndefined();
  });
  it("removes retired Research routes and limits public jobs to library indexing", async () => {
    for (const path of ["/memory", "/policy", "/evidence/verify", "/matrix/analyze", "/outline", "/review", "/search", "/screen", "/zotero", "/evaluation/review"]) {
      expect((await call(path, {})).status).toBe(404);
    }
    expect((await call("/jobs", { kind: "evidence" })).status).toBe(400);
    expect((await call("/jobs", { kind: "matrix" })).status).toBe(400);
  });
  it("saves and archives reading notes with optimistic revisions", async () => {
    const created = await call("/notes", { key: "alpha", text: "My reading note", page: 1 });
    expect(created.status).toBe(200);
    const note = await created.json() as { id: string; revision: number };
    expect((await (await call("/notes?key=alpha")).json() as unknown[])).toHaveLength(1);
    expect((await call("/notes", { ...note, key: "alpha", revision: 0, text: "Old note" })).status).toBe(422);
    expect((await call("/notes/archive", { ...note, archived: true })).status).toBe(200);
    expect((await (await call("/notes?key=alpha")).json() as unknown[])).toHaveLength(0);
  });
  it("exposes source pages and bounds graph queries without invoking a model", async () => {
    const source = (await (await call("/source/alpha/1")).json()) as any;
    expect(source.text).toContain("Actual paper text");
    expect((await call("/source/alpha/0")).status).toBe(400);
    const result = (await (
      await call("/graph/query", { query: "overview" })
    ).json()) as any;
    expect(result.projectCount).toBe(1);
    expect(result.pendingKeys).toEqual(["alpha"]);
    expect(
      (await call("/graph/query", { query: "missing", limit: 9000 })).status,
    ).toBe(400);
    const writing = await call("/writing-prompt");
    expect(writing.status).toBe(404);
  });
  it("never returns Zotero secrets and denies reading them as attached context", async () => {
    const { configureZotero } = await import("../src/research/zotero.js");
    configureZotero(id, { mode: "web", libraryType: "users", libraryId: "123", apiKey: "private-zotero-secret" });
    const text = await (await call("")).text();
    expect(text).not.toContain("private-zotero-secret");
    const read = (await (
      await call("/read", {
        key: "alpha",
        path: join(root, "research-secrets", `${id}.json`),
      })
    ).json()) as any;
    expect(read.text).toContain("unavailable");
    expect(read.text).not.toContain("private-zotero-secret");
  });
});
