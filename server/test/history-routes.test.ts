import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";

const mocks = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock("../src/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent.js")>()),
  runTurn: mocks.turn,
}));

const PORT = 4741;
const MOCK_PORT = 4742;
const REMOTE_ID = "abab1111cdcd2222efef3333";
const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const BASE = LINES.join("\n") + "\n";
const withLine = (text: string, n: number, value: string) => {
  const lines = text.split("\n");
  lines[n - 1] = value;
  return lines.join("\n");
};

let app: import("fastify").FastifyInstance;
let root: string;
let token: string;
let mock: MockOverleaf;
let config: typeof import("../src/config.js");

const call = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, payload, headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}` } });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-history-routes-"));
  const globalConfig = join(root, "gitconfig");
  writeFileSync(globalConfig, "[user]\n\tname = Grace Hopper\n\temail = grace@example.org\n");
  vi.stubEnv("BLATTBOT_DATA_DIR", join(root, "data"));
  vi.stubEnv("BLATTBOT_PORT", String(PORT));
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  mock = await startMockOverleaf(MOCK_PORT, REMOTE_ID);
  ({ app } = await import("../src/index.js"));
  config = await import("../src/config.js");
  token = (await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: `127.0.0.1:${PORT}` } })).json().token;
});

afterAll(async () => {
  await app?.close();
  await mock?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function localProject(name: string): Promise<{ id: string; dir: string }> {
  const created = await call("POST", "/api/projects", { local: true, name });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id as string;
  const dir = config.projectDir(id);
  writeFileSync(join(dir, "main.tex"), BASE);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "Fixture"]);
  return { id, dir };
}

const sh = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

async function transcript(id: string) {
  const { activeChatId } = (await call("GET", `/api/projects/${id}/chats`)).json();
  return { chatId: activeChatId as string, events: (await call("GET", `/api/projects/${id}/chats/${activeChatId}/transcript`)).json().events as any[] };
}

describe("history routes", () => {
  it("approve commits carry the user's identity and trailers, and the outcome is persisted", async () => {
    const { id, dir } = await localProject("Approve");
    writeFileSync(join(dir, "main.tex"), withLine(BASE, 3, "edited"));
    const res = await call("POST", `/api/projects/${id}/approve`, { message: "Manual edits" });
    expect(res.statusCode, res.body).toBe(200);
    const { chatId, events } = await transcript(id);
    expect(sh(dir, "log", "-1", "--format=%an <%ae>%n%B").trim()).toBe(
      `Grace Hopper <grace@example.org>\nManual edits\n\nBlattBot-Kind: local\nBlattBot-Chat: ${chatId}`,
    );
    const approved = events.find((e) => e.type === "approved");
    expect(approved).toMatchObject({
      pushed: false,
      projectKind: "local",
      files: ["main.tex"],
      commit: sh(dir, "rev-parse", "--short=7", "HEAD").trim(),
    });

    const list = await call("GET", `/api/projects/${id}/history?limit=1`);
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]).toMatchObject({ kind: "local", subject: "Manual edits", chatId, author: { name: "Grace Hopper" } });
    expect(page.nextOffset).toBe(1);
    expect(page.pendingRevert).toBeNull();
    const next = (await call("GET", `/api/projects/${id}/history?limit=5&offset=1&head=${page.head}`)).json();
    expect(next.commits.map((c: any) => c.subject)).toEqual(["Fixture", "New project"]);

    const detail = await call("GET", `/api/projects/${id}/history/${page.commits[0].sha}`);
    expect(detail.json().diff).toContain("+edited");
    expect((await call("GET", `/api/projects/${id}/history/not-a-sha`)).statusCode).toBe(400);
    expect((await call("GET", `/api/projects/${id}/history/0000000`)).statusCode).toBe(404);
  });

  it("reverts a commit as pending changes, and its approval is marked as a revert", async () => {
    const { id, dir } = await localProject("Revert");
    writeFileSync(join(dir, "main.tex"), withLine(BASE, 2, "agent line 2"));
    expect((await call("POST", `/api/projects/${id}/approve`, { message: "Agent: change line 2" })).statusCode).toBe(200);
    const target = sh(dir, "rev-parse", "HEAD").trim();
    // A later edit elsewhere in the file, still pending.
    writeFileSync(join(dir, "main.tex"), withLine(withLine(BASE, 2, "agent line 2"), 25, "pending 25"));

    const res = await call("POST", `/api/projects/${id}/history/${target}/revert`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ changed: ["main.tex"], conflicts: [], message: 'Revert "Agent: change line 2"' });
    expect(body.diff).toContain("+pending 25");
    expect(body.diff).toContain("-agent line 2\n+line 2\n");
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(withLine(BASE, 25, "pending 25"));
    expect(sh(dir, "rev-parse", "HEAD").trim()).toBe(target); // nothing committed

    const status = (await call("GET", `/api/projects/${id}/history/status?since=${target}`)).json();
    expect(status.pendingRevert).toMatchObject({ message: 'Revert "Agent: change line 2"', paths: ["main.tex"] });
    const { events } = await transcript(id);
    expect(events.at(-1)).toMatchObject({ type: "notice", text: expect.stringMatching(/^Reverted .* as pending changes/) });

    expect((await call("POST", `/api/projects/${id}/approve`, { message: body.message })).statusCode).toBe(200);
    const message = sh(dir, "log", "-1", "--format=%B");
    expect(message).toContain("BlattBot-Kind: revert");
    expect(message).toContain(`BlattBot-Reverts: ${target}`);
    const after = (await call("GET", `/api/projects/${id}/history`)).json();
    expect(after.commits[0]).toMatchObject({ kind: "revert", reverts: [target] });
    expect(after.pendingRevert).toBeNull();
  });

  it("a conflicting revert is reported and cannot be approved until resolved", async () => {
    const { id, dir } = await localProject("Conflict");
    writeFileSync(join(dir, "main.tex"), withLine(BASE, 2, "first"));
    await call("POST", `/api/projects/${id}/approve`, { message: "first" });
    const target = sh(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "main.tex"), withLine(BASE, 2, "second"));
    await call("POST", `/api/projects/${id}/approve`, { message: "second" });

    const res = (await call("POST", `/api/projects/${id}/history/${target}/revert`)).json();
    expect(res.conflicts).toEqual([{ path: "main.tex", reason: expect.stringMatching(/conflict/), markers: true }]);
    const { events } = await transcript(id);
    expect(events.at(-1)).toMatchObject({ type: "notice", tone: "warn", text: expect.stringMatching(/needs attention: main\.tex/) });

    const refused = await call("POST", `/api/projects/${id}/approve`, { message: "revert" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/Resolve the conflict markers in main\.tex/);
    writeFileSync(join(dir, "main.tex"), withLine(BASE, 2, "resolved"));
    expect((await call("POST", `/api/projects/${id}/approve`, { message: "revert" })).statusCode).toBe(200);
    expect(sh(dir, "log", "-1", "--format=%B")).toContain("BlattBot-Kind: revert");
  });

  it("refuses merge commits and any revert while an agent turn runs", async () => {
    const { id, dir } = await localProject("Busy");
    sh(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "side.tex"), "side\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "side");
    sh(dir, "checkout", "-q", "master");
    writeFileSync(join(dir, "other.tex"), "other\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "other");
    sh(dir, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
    const merge = sh(dir, "rev-parse", "HEAD").trim();
    const refused = await call("POST", `/api/projects/${id}/history/${merge}/revert`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatch(/merge commit/);

    let finish!: () => void;
    mocks.turn.mockImplementationOnce(async (_p, _m, sink) => {
      await new Promise<void>((resolve) => (finish = resolve));
      sink({ type: "turn_end", durationMs: 1 });
    });
    expect((await call("POST", `/api/projects/${id}/chat`, { message: "work" })).statusCode).toBe(200);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const busy = await call("POST", `/api/projects/${id}/history/${sh(dir, "rev-parse", "HEAD~1").trim()}/revert`);
    expect(busy.statusCode).toBe(409);
    expect(await import("../src/git.js").then((g) => g.hasChanges(dir))).toBe(false);
    finish();
    await vi.waitFor(async () => expect((await call("GET", `/api/projects/${id}`)).json().turnActive).toBe(false));
  });

  it("a forced approval records its backup, which the backup routes list and serve", async () => {
    const project = config.addProject({
      name: "Forced",
      kind: "overleaf",
      gitUrl: `http://127.0.0.1:${MOCK_PORT}/project/${REMOTE_ID}`,
      overleafBaseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      overleafProjectId: REMOTE_ID,
      cookie: "overleaf_session2=mock-session",
    });
    const dir = config.projectDir(project.id);
    mkdirSync(dir, { recursive: true });
    const git = await import("../src/git.js");
    await git.initRepo(dir);
    const main = "\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n";
    writeFileSync(join(dir, "main.tex"), main);
    mock.files.clear();
    mock.files.set("main.tex", Buffer.from(main));
    await git.commitAll(dir, "Initial sync from Overleaf", git.OVERLEAF_AUTHOR);

    writeFileSync(join(dir, "main.tex"), main.replace("Body.", "Mine."));
    mock.files.set("main.tex", Buffer.from(main.replace("Body.", "<b>Theirs</b>.")));
    expect((await call("POST", `/api/projects/${project.id}/approve`, { message: "x" })).statusCode).toBe(409);
    const forced = await call("POST", `/api/projects/${project.id}/approve`, { message: "Agent: mine", force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(mock.files.get("main.tex")?.toString()).toContain("Mine.");

    const { events } = await transcript(project.id);
    const approved = events.find((e) => e.type === "approved");
    expect(approved).toMatchObject({ pushed: true, projectKind: "overleaf", uploaded: ["main.tex"], files: ["main.tex"] });
    expect(approved.backup).toMatchObject({ files: ["main.tex"] });
    expect(approved.warnings.join("\n")).toContain("remote-backup");

    const backups = (await call("GET", `/api/projects/${project.id}/history/backups`)).json().backups;
    expect(backups).toEqual([{ stamp: approved.backup.stamp, at: expect.any(String), files: [{ path: "main.tex", size: expect.any(Number) }] }]);
    const file = await call("GET", `/api/projects/${project.id}/history/backups/${approved.backup.stamp}/file?path=main.tex`);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.body).toContain("<b>Theirs</b>.");
    const download = await call("GET", `/api/projects/${project.id}/history/backups/${approved.backup.stamp}/file?path=main.tex&download=1`);
    expect(download.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''main.tex");
    const escape = await call("GET", `/api/projects/${project.id}/history/backups/${approved.backup.stamp}/file?path=../../config`);
    expect(escape.statusCode).toBe(404);

    // The history shows who did what: Overleaf's import, then the user's push.
    const commits = (await call("GET", `/api/projects/${project.id}/history`)).json().commits;
    expect(commits.map((c: any) => [c.kind, c.author.name])).toEqual([
      ["approve", "Grace Hopper"],
      ["sync", "Overleaf"],
    ]);
  });
});
