// The pre-turn sync of an agent turn: Overleaf projects skip the project
// download while Overleaf reports no change; Git-bridge projects never start
// a turn on top of conflict markers a sync left behind.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";

const mocks = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock("../src/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent.js")>()),
  runTurn: mocks.turn,
}));

const REMOTE_ID = "abcdef0123456789abcdef01";
const MAIN = "\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

let app: import("fastify").FastifyInstance;
let mock: MockOverleaf;
let root: string, token: string, host: string;
let config: typeof import("../src/config.js");
let git: typeof import("../src/git.js");
const call = (path: string, payload?: Record<string, unknown>) =>
  app.inject({
    method: payload === undefined ? "GET" : "POST",
    url: path,
    headers: { host, authorization: `Bearer ${token}` },
    payload,
  });
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-turn-sync-"));
  const port = await freePort();
  host = `127.0.0.1:${port}`;
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.stubEnv("BLATTBOT_PORT", String(port));
  ({ app } = await import("../src/index.js"));
  config = await import("../src/config.js");
  git = await import("../src/git.js");
  token = (await call("/api/bootstrap")).json().token;
  mock = await startMockOverleaf(await freePort(), REMOTE_ID);
  mocks.turn.mockImplementation(async (_project, _message, sink) => sink({ type: "turn_end", durationMs: 1 }));
});
afterAll(async () => {
  await app?.close();
  await mock?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function settle(id: string) {
  for (let i = 0; i < 200; i++) {
    if (!(await call(`/api/projects/${id}`)).json().turnActive) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Turn did not settle");
}

async function turn(id: string) {
  const res = await call(`/api/projects/${id}/chat`, { message: "Fixture turn" });
  expect(res.statusCode, res.body).toBe(200);
  await settle(id);
}

async function lastTurnEvents(id: string): Promise<any[]> {
  const { activeChatId } = (await call(`/api/projects/${id}/chats`)).json();
  const events: any[] = (await call(`/api/projects/${id}/chats/${activeChatId}/transcript`)).json().events;
  return events.slice(events.map((e) => e.type).lastIndexOf("user_message"));
}

it("skips the project download before a turn while Overleaf reports no change", async () => {
  const accounts = await import("../src/accounts.js");
  const account = accounts.upsertAccount({ baseUrl: `http://127.0.0.1:${mock.port}`, cookie: "overleaf_session2=mock-session" });
  const project = config.addProject({
    name: "Quick sync",
    kind: "overleaf",
    gitUrl: "",
    accountId: account.id,
    overleafBaseUrl: account.baseUrl,
    overleafProjectId: REMOTE_ID,
    mainTex: "main.tex",
  });
  const dir = config.projectDir(project.id);
  mkdirSync(dir, { recursive: true });
  await git.initRepo(dir);
  writeFileSync(join(dir, "main.tex"), MAIN);
  await git.commitAll(dir, "Initial sync");
  mock.files.set("main.tex", Buffer.from(MAIN));

  const start = mock.zipDownloads;
  mocks.turn.mockClear();
  await turn(project.id); // nothing recorded yet: a full sync
  expect(mock.zipDownloads).toBe(start + 1);
  const recorded = config.getProject(project.id)!;
  expect(recorded.remoteLastUpdated).toBe(mock.lastUpdated());
  expect(recorded.lastSyncAt).toBeTruthy();
  // The detail API exposes what the client compares against.
  expect((await call(`/api/projects/${project.id}`)).json()).toMatchObject({
    remoteLastUpdated: recorded.remoteLastUpdated,
    lastSyncAt: recorded.lastSyncAt,
  });

  await turn(project.id);
  expect(mock.zipDownloads).toBe(start + 1);

  mock.files.set("main.tex", Buffer.from(MAIN.replace("Body.", "Co-author edit.")));
  await turn(project.id);
  expect(mock.zipDownloads).toBe(start + 2);
  expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Co-author edit.");
  expect(mocks.turn).toHaveBeenCalledTimes(3);
});

it("does not start a Git-bridge turn on top of conflict markers", async () => {
  const project = config.addProject({ name: "Git bridge", kind: "git", gitUrl: "", mainTex: "main.tex" });
  const dir = config.projectDir(project.id);
  mkdirSync(dir, { recursive: true });
  await git.initRepo(dir);
  writeFileSync(join(dir, "main.tex"), MAIN);
  await git.commitAll(dir, "Initial");
  const remote = join(root, "remote.git");
  const collaborator = join(root, "collaborator");
  run(dir, "clone", "--bare", dir, remote);
  run(dir, "remote", "add", "origin", remote);
  run(dir, "fetch", "origin");
  run(dir, "branch", `--set-upstream-to=origin/${run(dir, "branch", "--show-current").trim()}`);
  run(root, "clone", remote, collaborator);
  run(collaborator, "config", "user.name", "Fixture");
  run(collaborator, "config", "user.email", "fixture@example.org");
  writeFileSync(join(collaborator, "main.tex"), MAIN.replace("Body.", "Remote edit."));
  run(collaborator, "commit", "-am", "Remote edit");
  run(collaborator, "push");
  writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Local edit."));

  mocks.turn.mockClear();
  await turn(project.id);
  expect(mocks.turn).not.toHaveBeenCalled();
  expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("<<<<<<<");
  const events = await lastTurnEvents(project.id);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "notice", tone: "error", text: expect.stringMatching(/Not started: main\.tex .*conflict markers/) }),
  );
  expect(events.filter((e) => e.type === "turn_end")).toEqual([expect.objectContaining({ isError: true })]);

  // Once the markers are edited away, the turn runs.
  writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Resolved edit."));
  await turn(project.id);
  expect(mocks.turn).toHaveBeenCalledTimes(1);
});
