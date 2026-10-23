/**
 * Create / rename / delete project files from the Source panel
 * (routes/file-ops.ts): path safety, conflicts, the turn-active refusal, and
 * that every result is a normal pending change in the working diff.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock("../src/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent.js")>()),
  runTurn: mocks.turn,
}));

const PORT = 4723;
let app: import("fastify").FastifyInstance;
let root: string, token: string, outside: string;
const call = (method: "GET" | "POST" | "DELETE" | "PATCH", path: string, payload?: Record<string, unknown>) =>
  app.inject({
    method,
    url: path,
    payload,
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-file-ops-"));
  outside = mkdtempSync(join(tmpdir(), "blattbot-file-ops-outside-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.stubEnv("BLATTBOT_PORT", String(PORT));
  ({ app } = await import("../src/index.js"));
  token = (await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: `127.0.0.1:${PORT}` } })).json().token;
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function createProject(name: string): Promise<{ id: string; dir: string }> {
  const created = await call("POST", "/api/projects", { local: true, name });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id as string;
  return { id, dir: join(root, "projects", id) };
}

const pendingDiff = async (id: string) => (await call("GET", `/api/projects/${id}/diff`)).json().diff as string;

describe("create", () => {
  it("creates an empty file that shows as a new file in the working diff", async () => {
    const { id, dir } = await createProject("Create empty");
    const res = await call("POST", `/api/projects/${id}/files`, { path: "notes.tex" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.path).toBe("notes.tex");
    expect(body.files).toContain("notes.tex");
    expect(readFileSync(join(dir, "notes.tex"), "utf8")).toBe("");
    expect(body.diff).toContain("diff --git a/notes.tex b/notes.tex");
    expect(body.diff).toContain("new file mode");
    expect(await pendingDiff(id)).toContain("b/notes.tex");
  });

  it("creates missing folders on the path, with content", async () => {
    const { id, dir } = await createProject("Create nested");
    const res = await call("POST", `/api/projects/${id}/files`, {
      path: "chapters/one/intro.tex",
      content: "\\section{Intro}\n",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(readFileSync(join(dir, "chapters/one/intro.tex"), "utf8")).toBe("\\section{Intro}\n");
    expect(res.json().diff).toContain("+\\section{Intro}");
  });

  it("refuses an existing file and a file in the way of a folder", async () => {
    const { id } = await createProject("Create conflicts");
    expect((await call("POST", `/api/projects/${id}/files`, { path: "main.tex" })).statusCode).toBe(409);
    const blocked = await call("POST", `/api/projects/${id}/files`, { path: "main.tex/inner.tex" });
    expect(blocked.statusCode, blocked.body).toBe(409);
  });

  it("refuses paths outside the project, into .git, or through a symlink", async () => {
    const { id, dir } = await createProject("Create safety");
    symlinkSync(outside, join(dir, "linked"));
    for (const path of ["../escape.tex", "/etc/escape.tex", ".git/config", "sub/.GIT/hooks/x", "a//b.tex", "./a.tex", "linked/x.tex", "", 42]) {
      const res = await call("POST", `/api/projects/${id}/files`, { path });
      expect(res.statusCode, `${String(path)}: ${res.body}`).toBe(400);
    }
    expect(existsSync(join(outside, "x.tex"))).toBe(false);
    expect(existsSync(join(root, "projects", "escape.tex"))).toBe(false);
  });

  it("caps the content size", async () => {
    const { id } = await createProject("Create size");
    const res = await call("POST", `/api/projects/${id}/files`, { path: "big.tex", content: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
  });

  it("a created file deleted again leaves no pending change", async () => {
    const { id } = await createProject("Create then delete");
    expect((await call("POST", `/api/projects/${id}/files`, { path: "tmp/scratch.tex", content: "x\n" })).statusCode).toBe(200);
    const res = await call("DELETE", `/api/projects/${id}/files?path=${encodeURIComponent("tmp/scratch.tex")}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().diff.trim()).toBe("");
    expect(res.json().files).not.toContain("tmp/scratch.tex");
  });
});

describe("rename", () => {
  it("moves a file, shows it in the diff and keeps the main-file role", async () => {
    const { id, dir } = await createProject("Rename main");
    const res = await call("POST", `/api/projects/${id}/files/rename`, { from: "main.tex", to: "paper/paper.tex" });
    expect(res.statusCode, res.body).toBe(200);
    expect(existsSync(join(dir, "main.tex"))).toBe(false);
    expect(existsSync(join(dir, "paper/paper.tex"))).toBe(true);
    const diff = res.json().diff as string;
    // A rename may show as rename from/to or as delete + add — both name both paths.
    expect(diff).toContain("main.tex");
    expect(diff).toContain("paper/paper.tex");
    expect((await call("GET", `/api/projects/${id}`)).json().mainTex).toBe("paper/paper.tex");
  });

  it("removes folders a move leaves empty", async () => {
    const { id, dir } = await createProject("Rename prune");
    await call("POST", `/api/projects/${id}/files`, { path: "old/deep/a.tex", content: "a\n" });
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "old/deep/a.tex", to: "a.tex" })).statusCode).toBe(200);
    expect(existsSync(join(dir, "old"))).toBe(false);
  });

  it("refuses a missing source, an existing target, the same name and unsafe targets", async () => {
    const { id, dir } = await createProject("Rename conflicts");
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "nope.tex", to: "x.tex" })).statusCode).toBe(404);
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "main.tex", to: "references.bib" })).statusCode).toBe(409);
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "main.tex", to: "main.tex" })).statusCode).toBe(400);
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "main.tex", to: "../main.tex" })).statusCode).toBe(400);
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "main.tex", to: ".git/main.tex" })).statusCode).toBe(400);
    symlinkSync(join(outside, "target.tex"), join(dir, "link.tex"));
    writeFileSync(join(outside, "target.tex"), "secret");
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "link.tex", to: "copy.tex" })).statusCode).toBe(400);
    mkdirSync(join(dir, "folder"));
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "folder", to: "folder2" })).statusCode).toBe(400);
    expect(existsSync(join(dir, "main.tex"))).toBe(true);
  });
});

describe("delete", () => {
  it("deletes a file as a pending deletion", async () => {
    const { id, dir } = await createProject("Delete bib");
    const res = await call("DELETE", `/api/projects/${id}/files?path=references.bib`);
    expect(res.statusCode, res.body).toBe(200);
    expect(existsSync(join(dir, "references.bib"))).toBe(false);
    expect(res.json().diff).toContain("deleted file mode");
    expect(await pendingDiff(id)).toContain("a/references.bib");
  });

  it("deleting the main file falls back to detection", async () => {
    const { id } = await createProject("Delete main");
    await call("POST", `/api/projects/${id}/files`, { path: "other.tex", content: "\\documentclass{article}\n" });
    expect((await call("DELETE", `/api/projects/${id}/files?path=main.tex`)).statusCode).toBe(200);
    expect((await call("GET", `/api/projects/${id}`)).json().mainTex).toBe("other.tex");
  });

  it("refuses missing files, folders and unsafe paths", async () => {
    const { id, dir } = await createProject("Delete safety");
    writeFileSync(join(outside, "keep.tex"), "keep");
    symlinkSync(outside, join(dir, "linked"));
    expect((await call("DELETE", `/api/projects/${id}/files?path=nope.tex`)).statusCode).toBe(404);
    expect((await call("DELETE", `/api/projects/${id}/files?path=..%2Fx.tex`)).statusCode).toBe(400);
    expect((await call("DELETE", `/api/projects/${id}/files?path=.git%2FHEAD`)).statusCode).toBe(400);
    expect((await call("DELETE", `/api/projects/${id}/files?path=linked%2Fkeep.tex`)).statusCode).toBe(400);
    expect(existsSync(join(outside, "keep.tex"))).toBe(true);
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
  });

  it("answers 404 for an unknown project", async () => {
    expect((await call("DELETE", "/api/projects/nope/files?path=main.tex")).statusCode).toBe(404);
  });
});

describe("project list status", () => {
  it("counts the files with pending changes", async () => {
    const { id } = await createProject("Status counts");
    const entry = async () => (await call("GET", "/api/projects")).json().find((p: { id: string }) => p.id === id);
    expect(await entry()).toMatchObject({ pendingFiles: 0, turnActive: false, kind: "local" });
    await call("POST", `/api/projects/${id}/files`, { path: "a.tex", content: "a\n" });
    await call("DELETE", `/api/projects/${id}/files?path=references.bib`);
    expect((await entry()).pendingFiles).toBe(2);
    // Renames count both paths.
    await call("POST", `/api/projects/${id}/files/rename`, { from: "main.tex", to: "paper.tex" });
    expect((await entry()).pendingFiles).toBe(4);
  });
});

describe("main file selection", () => {
  it("lists .tex files with a \\documentclass and the current main file", async () => {
    const { id } = await createProject("Main candidates");
    await call("POST", `/api/projects/${id}/files`, { path: "slides/talk.tex", content: "% x\n\\documentclass{beamer}\n" });
    await call("POST", `/api/projects/${id}/files`, { path: "chapters/intro.tex", content: "\\section{Intro}\n" });
    await call("POST", `/api/projects/${id}/files`, { path: "commented.tex", content: "% \\documentclass{article}\n" });
    const res = await call("GET", `/api/projects/${id}/main-files`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ mainTex: "main.tex", chosen: false, candidates: ["main.tex", "slides/talk.tex"] });
  });

  it("sets mainTex and mainTexChosen through the project patch route", async () => {
    const { id } = await createProject("Main choose");
    await call("POST", `/api/projects/${id}/files`, { path: "slides/talk.tex", content: "\\documentclass{beamer}\n" });
    const res = await call("PATCH", `/api/projects/${id}`, { mainTex: "slides/talk.tex" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().project.mainTex).toBe("slides/talk.tex");
    const detail = (await call("GET", `/api/projects/${id}`)).json();
    expect(detail.mainTex).toBe("slides/talk.tex");
    expect(detail.mainTexChosen).toBe(true);
    expect((await call("GET", `/api/projects/${id}/main-files`)).json().chosen).toBe(true);
  });

  it("refuses a missing file, a non-.tex file and unsafe paths", async () => {
    const { id } = await createProject("Main refuse");
    expect((await call("PATCH", `/api/projects/${id}`, { mainTex: "nope.tex" })).statusCode).toBe(404);
    expect((await call("PATCH", `/api/projects/${id}`, { mainTex: "references.bib" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/projects/${id}`, { mainTex: "../main.tex" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/projects/${id}`, { mainTex: 7 })).statusCode).toBe(400);
    expect((await call("GET", `/api/projects/${id}`)).json().mainTexChosen).toBeUndefined();
  });
});

describe("while an agent turn runs", () => {
  it("refuses create, rename and delete with 409", async () => {
    const { id, dir } = await createProject("Busy files");
    let finish!: () => void;
    mocks.turn.mockImplementationOnce(async (_p, _m, sink) => {
      await new Promise<void>((resolve) => (finish = resolve));
      sink({ type: "turn_end", durationMs: 1 });
    });
    expect((await call("POST", `/api/projects/${id}/chat`, { message: "work" })).statusCode).toBe(200);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await call("POST", `/api/projects/${id}/files`, { path: "new.tex" })).statusCode).toBe(409);
    expect((await call("POST", `/api/projects/${id}/files/rename`, { from: "main.tex", to: "x.tex" })).statusCode).toBe(409);
    expect((await call("DELETE", `/api/projects/${id}/files?path=main.tex`)).statusCode).toBe(409);
    expect(existsSync(join(dir, "new.tex"))).toBe(false);
    expect(existsSync(join(dir, "main.tex"))).toBe(true);
    // The project list reports the running turn (dashboard / sidebar status).
    const listed = (await call("GET", "/api/projects")).json().find((p: { id: string }) => p.id === id);
    expect(listed.turnActive).toBe(true);
    finish();
    await vi.waitFor(async () => expect((await call("GET", `/api/projects/${id}`)).json().turnActive).toBe(false));
    expect((await call("POST", `/api/projects/${id}/files`, { path: "new.tex" })).statusCode).toBe(200);
  });
});
