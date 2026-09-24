import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({ turn: vi.fn(), compile: vi.fn() }));
vi.mock("../src/agent.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent.js")>(), runTurn: mocks.turn,
}));
vi.mock("../src/compile.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/compile.js")>(), compileProject: mocks.compile,
}));

let app: import("fastify").FastifyInstance;
let root: string, dir: string, id: string, token: string, original: string;
const call = (path: string, payload?: Record<string, unknown>) => app.inject({
  method: payload === undefined ? "GET" : "POST", url: path,
  headers: { host: "127.0.0.1:4667", authorization: `Bearer ${token}` }, payload,
});
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-turn-compile-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.stubEnv("BLATTBOT_PORT", "4667");
  ({ app } = await import("../src/index.js"));
  token = (await call("/api/bootstrap")).json().token;
  const created = await call("/api/projects", { local: true, name: "Compile regression" });
  expect(created.statusCode, created.body).toBe(200);
  id = created.json().id;
  const config = await import("../src/config.js");
  dir = config.projectDir(id);
  original = readFileSync(join(dir, "main.tex"), "utf8");
  mocks.compile.mockImplementation(async () => ({ ok: true, engine: "fixture", mainTex: "main.tex",
    errors: [], logTail: "", durationMs: 1, pdfPath: join(root, "fixture.pdf") }));
});
afterAll(async () => {
  await app?.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

async function turn(edit: () => void) {
  mocks.compile.mockClear();
  mocks.turn.mockImplementation(async (_project, _message, sink) => {
    edit(); sink({ type: "turn_end", durationMs: 1 });
  });
  expect((await call(`/api/projects/${id}/chat`, { message: "Fixture turn" })).statusCode).toBe(200);
  for (let i = 0; i < 100; i++) {
    if (!(await call(`/api/projects/${id}`)).json().turnActive) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Turn did not settle");
}

it("does not compile a read-only turn, even with existing unapproved edits", async () => {
  writeFileSync(join(dir, "main.tex"), original + "\n% older pending edit\n");
  await turn(() => {});
  expect(mocks.compile).not.toHaveBeenCalled();
});

it("compiles edits and keeps the PDF version stable across project refreshes", async () => {
  await turn(() => writeFileSync(join(dir, "main.tex"), original + "\n% new edit\n"));
  expect(mocks.compile).toHaveBeenCalledTimes(1);
  const before = (await call(`/api/projects/${id}`)).json().lastCompile.pdfVersion;
  expect(before).toBeTruthy();
  await turn(() => {});
  expect(mocks.compile).not.toHaveBeenCalled();
  expect((await call(`/api/projects/${id}`)).json().lastCompile.pdfVersion).toBe(before);
});

it("compiles a revert to HEAD even though the final diff is empty", async () => {
  await turn(() => writeFileSync(join(dir, "main.tex"), original));
  expect((await call(`/api/projects/${id}/diff`)).json().diff.trim()).toBe("");
  expect(mocks.compile).toHaveBeenCalledTimes(1);
});

it("does not compile when edits are undone within the same turn", async () => {
  await turn(() => {
    writeFileSync(join(dir, "main.tex"), original + "Temporary edit");
    writeFileSync(join(dir, "main.tex"), original);
  });
  expect(mocks.compile).not.toHaveBeenCalled();
});

it("detects added and deleted files, but ignores Git bookkeeping", async () => {
  await turn(() => writeFileSync(join(dir, "extra.tex"), "New content"));
  expect(mocks.compile).toHaveBeenCalledTimes(1);
  await turn(() => rmSync(join(dir, "extra.tex")));
  expect(mocks.compile).toHaveBeenCalledTimes(1);
  await turn(() => writeFileSync(join(dir, ".git", "description"), "Bookkeeping only"));
  expect(mocks.compile).not.toHaveBeenCalled();
});
