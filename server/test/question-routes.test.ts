/**
 * HTTP coverage of the mid-turn question routes: answer + dismiss glue,
 * 400 (bad/foreign answer keys), 404 vs 410 semantics — including the
 * cross-project case (an id settled under another project must 404, not 410).
 * Boots the real server in-process against an isolated data dir.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_PORT = 4662;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

const QUESTION = {
  question: "Which section should I improve?",
  header: "Section",
  options: [
    { label: "Introduction", description: "Rework the opening" },
    { label: "Conclusion", description: "Strengthen the ending" },
  ],
  multiSelect: false,
};

describe("question routes over HTTP", () => {
  let dataDir: string;
  let app: import("fastify").FastifyInstance;
  let token: string;
  /** The questions module INSTANCE the booted server uses (same registry). */
  let q: typeof import("../src/questions.js");
  let projectId: string;
  let otherProjectId: string;

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

  const answerUrl = (project: string, questionId: string) =>
    `/api/projects/${project}/question/${questionId}`;

  beforeAll(async () => {
    // Boot the real server in-process against an isolated data dir; index.ts
    // listens at import time, so the env must be stubbed before the import.
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-questionroutes-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.stubEnv("BLATTBOT_PORT", String(SERVER_PORT));
    vi.resetModules();
    ({ app } = await import("../src/index.js"));
    // Imported AFTER index.js without a reset in between → the SAME module
    // instance (and pending-question registry) the routes consult.
    q = await import("../src/questions.js");
    const boot = await fetch(`${SERVER_BASE}/api/bootstrap`);
    token = ((await boot.json()) as { token: string }).token;

    for (const name of ["Question Routes", "Question Routes B"]) {
      const created = await call("/api/projects", {
        method: "POST",
        body: { local: true, name },
      });
      expect(created.status).toBe(200);
      const id = ((await created.json()) as { id: string }).id;
      if (name === "Question Routes") projectId = id;
      else otherProjectId = id;
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("answers the pending question and resolves the registry promise", async () => {
    const { pending, resolution } = q.registerQuestion(projectId, [QUESTION]);
    const answers = { [QUESTION.question]: "Introduction" };
    const res = await call(answerUrl(projectId, pending.questionId), {
      method: "POST",
      body: { answers },
    });
    expect(res.status).toBe(200);
    await expect(resolution).resolves.toEqual({ kind: "answered", answers });
    // Settled: a second answer (and a dismiss) now get 410, not 404.
    const again = await call(answerUrl(projectId, pending.questionId), {
      method: "POST",
      body: { answers },
    });
    expect(again.status).toBe(410);
    const dismissAgain = await call(`${answerUrl(projectId, pending.questionId)}/dismiss`, {
      method: "POST",
    });
    expect(dismissAgain.status).toBe(410);
  });

  it("rejects answers with foreign keys or a missing required answer with 400", async () => {
    const { pending } = q.registerQuestion(projectId, [QUESTION]);
    try {
      const foreign = await call(answerUrl(projectId, pending.questionId), {
        method: "POST",
        body: { answers: { [QUESTION.question]: "Introduction", smuggled: "x".repeat(500) } },
      });
      expect(foreign.status).toBe(400);
      expect(((await foreign.json()) as { error: string }).error).toMatch(/unknown question/);
      const missing = await call(answerUrl(projectId, pending.questionId), {
        method: "POST",
        body: { answers: { "Some other question?": "A" } },
      });
      expect(missing.status).toBe(400);
      const empty = await call(answerUrl(projectId, pending.questionId), {
        method: "POST",
        body: {},
      });
      expect(empty.status).toBe(400);
      // The question survives failed validation and is still answerable.
      expect(q.questionStatus(projectId, pending.questionId)).toBe("pending");
    } finally {
      q.abortQuestion(projectId);
    }
  });

  it("dismisses the pending question over the dismiss route", async () => {
    const { pending, resolution } = q.registerQuestion(projectId, [QUESTION]);
    const res = await call(`${answerUrl(projectId, pending.questionId)}/dismiss`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    await expect(resolution).resolves.toEqual({ kind: "dismissed" });
  });

  it("404s unknown ids and unknown projects on both routes", async () => {
    const unknownAnswer = await call(answerUrl(projectId, "q-doesnotexist"), {
      method: "POST",
      body: { answers: { [QUESTION.question]: "Introduction" } },
    });
    expect(unknownAnswer.status).toBe(404);
    const unknownDismiss = await call(`${answerUrl(projectId, "q-doesnotexist")}/dismiss`, {
      method: "POST",
    });
    expect(unknownDismiss.status).toBe(404);
    const noProject = await call(answerUrl("nope", "q-doesnotexist"), {
      method: "POST",
      body: { answers: { [QUESTION.question]: "Introduction" } },
    });
    expect(noProject.status).toBe(404);
  });

  it("an id settled under another project gets 404 here, not 410", async () => {
    const { pending } = q.registerQuestion(otherProjectId, [QUESTION]);
    const settled = await call(answerUrl(otherProjectId, pending.questionId), {
      method: "POST",
      body: { answers: { [QUESTION.question]: "Conclusion" } },
    });
    expect(settled.status).toBe(200);
    // Same id posted to the OTHER project: unknown there → 404 on both routes.
    const crossAnswer = await call(answerUrl(projectId, pending.questionId), {
      method: "POST",
      body: { answers: { [QUESTION.question]: "Conclusion" } },
    });
    expect(crossAnswer.status).toBe(404);
    const crossDismiss = await call(`${answerUrl(projectId, pending.questionId)}/dismiss`, {
      method: "POST",
    });
    expect(crossDismiss.status).toBe(404);
    // …while its own project still reports it settled.
    const own = await call(answerUrl(otherProjectId, pending.questionId), {
      method: "POST",
      body: { answers: { [QUESTION.question]: "Conclusion" } },
    });
    expect(own.status).toBe(410);
  });
});
