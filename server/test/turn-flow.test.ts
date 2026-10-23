// The turn lifecycle over HTTP with a fixture backend: checkpoints on
// turn_end, Show changes / Undo turn, restore points for discards, the
// message queue, explicit chat ids, and the refresh build after the turn.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "../scripts/free-port.js";

const mocks = vi.hoisted(() => ({ turn: vi.fn(), compile: vi.fn() }));
vi.mock("../src/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent.js")>()),
  runTurn: mocks.turn,
}));
vi.mock("../src/compile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compile.js")>()),
  compileProject: mocks.compile,
}));

let app: import("fastify").FastifyInstance;
let root: string, token: string, host: string;
let config: typeof import("../src/config.js");
let chats: typeof import("../src/chats.js");

const call = (method: "GET" | "POST" | "DELETE" | "PUT", path: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: path, headers: { host, authorization: `Bearer ${token}` }, payload });

/** A turn the test ends by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-turn-flow-"));
  const port = await freePort();
  host = `127.0.0.1:${port}`;
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.stubEnv("BLATTBOT_PORT", String(port));
  ({ app } = await import("../src/index.js"));
  config = await import("../src/config.js");
  chats = await import("../src/chats.js");
  token = (await call("GET", "/api/bootstrap")).json().token;
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});
beforeEach(() => {
  mocks.turn.mockReset();
  mocks.compile.mockReset();
  mocks.compile.mockImplementation(async () => ({ ok: true, engine: "fixture", mainTex: "main.tex", errors: [], logTail: "", durationMs: 1 }));
});

async function createProject(name: string): Promise<{ id: string; dir: string }> {
  const created = await call("POST", "/api/projects", { local: true, name });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id;
  return { id, dir: config.projectDir(id) };
}

async function settle(id: string) {
  for (let i = 0; i < 300; i++) {
    const d = (await call("GET", `/api/projects/${id}`)).json();
    if (!d.turnActive && !d.compiling) return d;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Turn did not settle");
}

async function transcript(id: string, chatId: string): Promise<any[]> {
  return (await call("GET", `/api/projects/${id}/chats/${chatId}/transcript`)).json().events;
}

const lastTurnEnd = (events: any[]) => events.filter((e) => e.type === "turn_end").at(-1);

describe("turn checkpoints", () => {
  it("puts the checkpoint on turn_end, shows the turn's diff and undoes it keeping later edits", async () => {
    const { id, dir } = await createProject("Checkpoints");
    const original = readFileSync(join(dir, "main.tex"), "utf8");
    mocks.turn.mockImplementationOnce(async (_p, _m, sink) => {
      writeFileSync(join(dir, "main.tex"), original.replace("Start writing here.", "The agent wrote this."));
      writeFileSync(join(dir, "agent-notes.tex"), "notes\n");
      sink({ type: "turn_end", isError: false, durationMs: 5 });
    });
    const sent = await call("POST", `/api/projects/${id}/chat`, { message: "Write the intro" });
    expect(sent.json()).toMatchObject({ ok: true });
    const chatId = sent.json().chatId;
    await settle(id);

    const end = lastTurnEnd(await transcript(id, chatId));
    expect(end).toMatchObject({ isError: false, durationMs: 5, turnRef: `${chatId}.1`, fileCount: 2, additions: 2, deletions: 1 });
    expect(end.beforeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(end.files.map((f: any) => f.path)).toEqual(["agent-notes.tex", "main.tex"]);
    // The post-turn refresh ran (outside the busy window).
    expect(mocks.compile).toHaveBeenCalledTimes(1);

    const shown = (await call("GET", `/api/projects/${id}/turns/${end.turnRef}/diff`)).json();
    expect(shown.diff).toContain("+The agent wrote this.");
    expect(shown.diff).toContain("agent-notes.tex");

    // The user edits another line after the turn; undo keeps it.
    const later = readFileSync(join(dir, "main.tex"), "utf8").replace("\\section{Introduction}", "\\section{Overview}");
    writeFileSync(join(dir, "main.tex"), later);
    const undone = await call("POST", `/api/projects/${id}/turns/${end.turnRef}/undo`);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toMatchObject({ restored: ["agent-notes.tex"], merged: ["main.tex"], conflicts: [] });
    expect(undone.json().discardId).toBeTruthy();
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(original.replace("\\section{Introduction}", "\\section{Overview}"));
    expect(existsSync(join(dir, "agent-notes.tex"))).toBe(false);
    expect((await transcript(id, chatId)).at(-1)).toMatchObject({ type: "turn_undone", turnRef: end.turnRef, tone: "ok" });

    // The undo has its own restore point.
    const back = await call("POST", `/api/projects/${id}/discards/${undone.json().discardId}/restore`, { turnRef: end.turnRef });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ reported: true, text: expect.stringContaining("Turn restored") });
    expect(readFileSync(join(dir, "agent-notes.tex"), "utf8")).toBe("notes\n");
    expect((await transcript(id, chatId)).at(-1)).toMatchObject({ type: "turn_redone", turnRef: end.turnRef });

    expect((await call("GET", `/api/projects/${id}/turns/${chatId}.9/diff`)).statusCode).toBe(404);
    expect((await call("GET", `/api/projects/${id}/turns/bad..ref/diff`)).statusCode).toBe(400);
  });

  it("refuses to undo while a turn runs", async () => {
    const { id } = await createProject("Busy undo");
    const hold = deferred();
    mocks.turn.mockImplementationOnce(async (_p, _m, sink) => {
      await hold.promise;
      sink({ type: "turn_end", isError: false });
    });
    const chatId = (await call("POST", `/api/projects/${id}/chat`, { message: "slow" })).json().chatId;
    const refused = await call("POST", `/api/projects/${id}/turns/${chatId}.1/undo`);
    expect(refused.statusCode).toBe(409);
    hold.resolve();
    await settle(id);
  });
});

describe("discard restore points", () => {
  it("returns a restore point for discard all, one file and one hunk", async () => {
    const { id, dir } = await createProject("Discards");
    const original = readFileSync(join(dir, "main.tex"), "utf8");

    writeFileSync(join(dir, "main.tex"), original.replace("Start writing here.", "Manual edit."));
    writeFileSync(join(dir, "draft.tex"), "draft\n");
    const all = (await call("POST", `/api/projects/${id}/reject`)).json();
    expect(all.discardId).toMatch(/^\d{13}-[0-9a-f]{6}$/);
    expect(all.files.map((f: any) => f.path).sort()).toEqual(["draft.tex", "main.tex"]);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(original);
    const restored = await call("POST", `/api/projects/${id}/discards/${all.discardId}/restore`);
    expect(restored.json()).toMatchObject({ ok: true, restored: ["draft.tex", "main.tex"], tone: "ok" });
    expect(readFileSync(join(dir, "draft.tex"), "utf8")).toBe("draft\n");
    expect((await call("POST", `/api/projects/${id}/discards/${all.discardId}/restore`)).statusCode).toBe(404);

    const file = (await call("POST", `/api/projects/${id}/reject-file`, { path: "draft.tex" })).json();
    expect(file.discardId).toBeTruthy();
    expect(existsSync(join(dir, "draft.tex"))).toBe(false);
    await call("POST", `/api/projects/${id}/discards/${file.discardId}/restore`);
    expect(existsSync(join(dir, "draft.tex"))).toBe(true);
    await call("POST", `/api/projects/${id}/reject-file`, { path: "draft.tex" });

    const diff = (await call("GET", `/api/projects/${id}/diff`)).json().diff;
    const hunk = (await call("POST", `/api/projects/${id}/reject-hunk`, { patch: diff })).json();
    expect(hunk.discardId).toBeTruthy();
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(original);
    await call("POST", `/api/projects/${id}/discards/${hunk.discardId}/restore`);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Manual edit.");
  });
});

describe("message queue", () => {
  it("queues messages sent during a turn and runs them in order", async () => {
    const { id } = await createProject("Queue order");
    const hold = deferred();
    const prompts: string[] = [];
    mocks.turn.mockImplementation(async (_p, prompt, sink) => {
      prompts.push(prompt);
      if (prompt === "first") await hold.promise;
      sink({ type: "turn_end", isError: false });
    });
    expect((await call("POST", `/api/projects/${id}/chat`, { message: "first" })).json().queued).toBeUndefined();
    const second = (await call("POST", `/api/projects/${id}/chat`, { message: "second" })).json();
    const third = (await call("POST", `/api/projects/${id}/chat`, { message: "third" })).json();
    expect(second).toMatchObject({ ok: true, queued: true });
    expect(third.queue.items.map((i: any) => i.text)).toEqual(["second", "third"]);
    const removed = (await call("DELETE", `/api/projects/${id}/queue/${third.queueId}`)).json();
    expect(removed.items.map((i: any) => i.text)).toEqual(["second"]);
    await call("POST", `/api/projects/${id}/chat`, { message: "fourth" });
    expect((await call("GET", `/api/projects/${id}`)).json().queue.items.map((i: any) => i.text)).toEqual(["second", "fourth"]);

    hold.resolve();
    for (let i = 0; i < 200 && prompts.length < 3; i++) await new Promise((r) => setTimeout(r, 15));
    const detail = await settle(id);
    expect(prompts).toEqual(["first", "second", "fourth"]);
    expect(detail.queue).toEqual({ items: [], paused: null });
    // Each queued message reached the transcript when its turn started.
    const { activeChatId } = (await call("GET", `/api/projects/${id}/chats`)).json();
    expect((await transcript(id, activeChatId)).filter((e) => e.type === "user_message").map((e) => e.text)).toEqual([
      "first",
      "second",
      "fourth",
    ]);
  });

  it("caps the queue", async () => {
    const { id } = await createProject("Queue cap");
    const hold = deferred();
    mocks.turn.mockImplementation(async (_p, _m, sink) => {
      await hold.promise;
      sink({ type: "turn_end", isError: false });
    });
    await call("POST", `/api/projects/${id}/chat`, { message: "running" });
    for (let i = 0; i < 5; i++) expect((await call("POST", `/api/projects/${id}/chat`, { message: `q${i}` })).statusCode).toBe(200);
    const full = await call("POST", `/api/projects/${id}/chat`, { message: "one too many" });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toContain("At most 5");
    // Removing the project drops the queue.
    for (const item of (await call("GET", `/api/projects/${id}/queue`)).json().items) {
      await call("DELETE", `/api/projects/${id}/queue/${item.id}`);
    }
    hold.resolve();
    await settle(id);
  });

  it.each([
    ["error", { isError: true }],
    ["interrupted", { isError: false, interrupted: true }],
  ] as const)("pauses after a turn that ended with %s, until resumed", async (reason, end) => {
    const { id } = await createProject(`Queue pause ${reason}`);
    const hold = deferred();
    const prompts: string[] = [];
    mocks.turn.mockImplementation(async (_p, prompt, sink) => {
      prompts.push(prompt);
      if (prompt === "fails") {
        await hold.promise;
        sink({ type: "turn_end", ...end });
        return;
      }
      sink({ type: "turn_end", isError: false });
    });
    await call("POST", `/api/projects/${id}/chat`, { message: "fails" });
    await call("POST", `/api/projects/${id}/chat`, { message: "waits" });
    hold.resolve();
    const paused = await settle(id);
    expect(prompts).toEqual(["fails"]);
    expect(paused.queue).toMatchObject({ paused: reason, items: [{ text: "waits" }] });

    const resumed = (await call("POST", `/api/projects/${id}/queue/resume`)).json();
    expect(resumed.started).toBe(true);
    await settle(id);
    expect(prompts).toEqual(["fails", "waits"]);
  });

  it("drops the queue when the project is removed", async () => {
    const { id } = await createProject("Queue removal");
    const queue = await import("../src/turn-queue.js");
    const hold = deferred();
    mocks.turn.mockImplementation(async (_p, _m, sink) => {
      await hold.promise;
      sink({ type: "turn_end", isError: true });
    });
    await call("POST", `/api/projects/${id}/chat`, { message: "fails" });
    await call("POST", `/api/projects/${id}/chat`, { message: "never runs" });
    hold.resolve();
    expect((await settle(id)).queue.items).toHaveLength(1);
    expect((await call("DELETE", `/api/projects/${id}`)).statusCode).toBe(200);
    expect(queue.queueState(id)).toEqual({ items: [], paused: null });
  });
});

describe("explicit chat ids", () => {
  it("sends each message to the chat it was written in, not the last activated one", async () => {
    const { id } = await createProject("Two chats");
    const first = (await call("GET", `/api/projects/${id}/chats`)).json().activeChatId;
    const second = (await call("POST", `/api/projects/${id}/chats`)).json().id;
    chats.updateChat(id, second, { sessionId: "codex-second-session" });
    // Tab 1 activates the first chat after tab 2 created the second one.
    await call("POST", `/api/projects/${id}/chats/${first}/activate`);
    const sessions: (string | undefined)[] = [];
    mocks.turn.mockImplementation(async (_p, _m, sink, _mode, _scope, session) => {
      sessions.push(session?.sessionId);
      sink({ type: "turn_end", isError: false });
    });

    // Tab 2 still shows the second chat and sends there.
    const sent = await call("POST", `/api/projects/${id}/chat`, { message: "for the second chat", chatId: second });
    expect(sent.json()).toMatchObject({ ok: true, chatId: second });
    await settle(id);
    expect((await transcript(id, second)).some((e) => e.type === "user_message" && e.text === "for the second chat")).toBe(true);
    expect((await transcript(id, first)).some((e) => e.type === "user_message")).toBe(false);
    expect(sessions).toEqual(["codex-second-session"]);

    // Older clients without a chat id still reach the active chat.
    expect((await call("POST", `/api/projects/${id}/chat`, { message: "legacy" })).json().chatId).toBe(first);
    await settle(id);
    expect((await call("POST", `/api/projects/${id}/chat`, { message: "x", chatId: "chat-nope" })).statusCode).toBe(404);
    expect((await call("POST", `/api/projects/${id}/chat`, { message: "x", chatId: 42 })).statusCode).toBe(404);
  });

  it("starts a queued message in the chat it was written in", async () => {
    const { id } = await createProject("Queued chat");
    const first = (await call("GET", `/api/projects/${id}/chats`)).json().activeChatId;
    const second = (await call("POST", `/api/projects/${id}/chats`)).json().id;
    const hold = deferred();
    mocks.turn.mockImplementation(async (_p, prompt, sink) => {
      if (prompt === "running") await hold.promise;
      sink({ type: "turn_end", isError: false });
    });
    await call("POST", `/api/projects/${id}/chat`, { message: "running", chatId: first });
    await call("POST", `/api/projects/${id}/chat`, { message: "queued for second", chatId: second });
    hold.resolve();
    await settle(id);
    for (let i = 0; i < 100 && !(await transcript(id, second)).some((e) => e.type === "turn_end"); i++) await settle(id);
    expect((await transcript(id, second)).map((e) => e.type)).toEqual(["user_message", "turn_end"]);
    expect((await transcript(id, first)).filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["running"]);
  });
});

describe("post-turn compile", () => {
  it("runs after the turn has ended, so the project is no longer busy", async () => {
    const { id, dir } = await createProject("Late compile");
    const build = deferred();
    mocks.compile.mockImplementationOnce(async () => {
      await build.promise;
      return { ok: true, engine: "fixture", mainTex: "main.tex", errors: [], logTail: "", durationMs: 1 };
    });
    mocks.turn.mockImplementationOnce(async (_p, _m, sink) => {
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\\begin{document}changed\\end{document}\n");
      sink({ type: "turn_end", isError: false });
    });
    await call("POST", `/api/projects/${id}/chat`, { message: "edit" });
    let detail: any;
    for (let i = 0; i < 200; i++) {
      detail = (await call("GET", `/api/projects/${id}`)).json();
      if (!detail.turnActive) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(detail).toMatchObject({ turnActive: false, compiling: true });
    // Discard (a busy-guarded action) works while the build still runs.
    expect((await call("POST", `/api/projects/${id}/reject`)).statusCode).toBe(200);
    build.resolve();
    expect((await settle(id)).compiling).toBe(false);
  });
});
