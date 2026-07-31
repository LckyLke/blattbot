/**
 * OpenAI-compatible backend tests: a mock OpenAI-style server (node:http,
 * scripted SSE fixtures) drives the full tool-calling loop through the real
 * agent.runTurn dispatcher, plus unit tests for the history cap, path
 * validation, and the prompt/name mappings. No real endpoint is ever hit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Mock OpenAI-compatible server -----------------------------------------

type Fixture =
  | { kind: "text"; text: string; malformed?: boolean; usage?: { prompt: number; completion: number } }
  | {
      kind: "tools";
      text?: string;
      malformed?: boolean;
      calls: { name: string; args: unknown }[];
      usage?: { prompt: number; completion: number };
    }
  | { kind: "error"; status: number; body?: string }
  | { kind: "hang" };

interface Recorded {
  url: string;
  auth: string | undefined;
  body: any;
}

class MockOpenAI {
  server: Server;
  port = 0;
  requests: Recorded[] = [];
  queue: Fixture[] = [];
  /** When set, every request answers with this tool call (iteration-cap test). */
  loopCall: { name: string; args: unknown } | null = null;
  private open = new Set<ServerResponse>();
  private nextCallId = 0;

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body: any = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* leave null */
        }
        this.requests.push({ url: req.url ?? "", auth: req.headers.authorization, body });
        const fixture: Fixture =
          this.loopCall != null
            ? { kind: "tools", calls: [this.loopCall] }
            : this.queue.shift() ?? { kind: "text", text: "(mock: no fixture queued)" };
        this.respond(res, fixture);
      });
    });
  }

  private sse(res: ServerResponse, obj: unknown): void {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  private respond(res: ServerResponse, fixture: Fixture): void {
    if (fixture.kind === "error") {
      res.writeHead(fixture.status, { "Content-Type": "application/json" });
      res.end(fixture.body ?? JSON.stringify({ error: { message: "mock failure" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    this.open.add(res);
    res.on("close", () => this.open.delete(res));
    if (fixture.kind === "hang") {
      this.sse(res, { choices: [{ delta: { content: "starting…" } }] });
      return; // never finishes — the client must abort
    }
    if (fixture.malformed) {
      res.write(": keepalive comment\n\n");
      res.write("data: {this is not json\n\n");
      res.write("event: message\n\n");
    }
    const text = fixture.kind === "text" ? fixture.text : fixture.text ?? "";
    if (text) {
      const mid = Math.ceil(text.length / 2);
      this.sse(res, { choices: [{ delta: { role: "assistant", content: text.slice(0, mid) } }] });
      if (fixture.malformed) res.write("data: [oops\n\n");
      this.sse(res, { choices: [{ delta: { content: text.slice(mid) } }] });
    }
    if (fixture.kind === "tools") {
      fixture.calls.forEach((call, index) => {
        const args = JSON.stringify(call.args ?? {});
        const mid = Math.ceil(args.length / 2);
        this.sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index, id: `call_${this.nextCallId++}`, function: { name: call.name, arguments: "" } },
                ],
              },
            },
          ],
        });
        // Arguments stream in two fragments, like real servers do.
        this.sse(res, {
          choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(0, mid) } }] } }],
        });
        this.sse(res, {
          choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(mid) } }] } }],
        });
      });
      this.sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      this.sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    if (fixture.usage) {
      // The final usage chunk of stream_options.include_usage: empty choices.
      this.sse(res, {
        choices: [],
        usage: { prompt_tokens: fixture.usage.prompt, completion_tokens: fixture.usage.completion },
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const res of this.open) res.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

// ---- Harness ----------------------------------------------------------------

let dataDir: string;
let mock: MockOpenAI;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-oai-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
  mock = new MockOpenAI();
  await mock.start();
});

afterEach(async () => {
  await mock.close();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

const MAIN_TEX = "\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n";

async function setup(extraSettings: Record<string, string> = {}) {
  const config = await import("../src/config.js");
  const settings = await import("../src/settings.js");
  const agent = await import("../src/agent.js");
  const openai = await import("../src/backends/openai.js");
  settings.saveSettings({
    backend: "openai",
    openaiBaseUrl: `http://127.0.0.1:${mock.port}/v1`,
    openaiModel: "test-model",
    ...extraSettings,
  });
  const project = config.addProject({ name: "OAI Test", gitUrl: "local", kind: "local" });
  const dir = config.projectDir(project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tex"), MAIN_TEX);
  return { config, settings, agent, openai, project, dir };
}

type Ev = { type: string; [key: string]: unknown };

function runCollected(
  agent: typeof import("../src/agent.js"),
  project: import("../src/config.js").Project,
  prompt: string,
  opts: { mode?: import("../src/agent.js").AgentMode; sessionId?: string } = {},
) {
  const events: Ev[] = [];
  let sessionId: string | undefined;
  const done = agent.runTurn(project, prompt, (e) => events.push(e), opts.mode ?? "edit", undefined, {
    sessionId: opts.sessionId,
    onSessionId: (id) => (sessionId = id),
  });
  return { events, done, session: () => sessionId };
}

// ---- Integration: the full loop against the mock ----------------------------

describe("openai backend turn loop", () => {
  it("runs list_files → read_file → edit_file → final text with the full event contract", async () => {
    const { agent, project, dir } = await setup();
    mock.queue = [
      { kind: "tools", calls: [{ name: "list_files", args: {} }] },
      { kind: "tools", calls: [{ name: "read_file", args: { path: "main.tex" } }] },
      {
        kind: "tools",
        text: "Making the edit.",
        calls: [
          { name: "edit_file", args: { path: "main.tex", old_string: "Hello world.", new_string: "Goodbye world." } },
        ],
      },
      { kind: "text", text: "All done." },
    ];

    const { events, done, session } = runCollected(agent, project, "Change the greeting");
    await done;

    // The edit really landed on disk.
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(MAIN_TEX.replace("Hello world.", "Goodbye world."));

    // Event contract: names mapped for livediff/UI, details are the main arg.
    const uses = events.filter((e) => e.type === "tool_use");
    expect(uses.map((e) => e.name)).toEqual(["list_files", "Read", "Edit"]);
    expect(uses[1].detail).toBe("main.tex");
    expect(uses[2].detail).toBe("main.tex");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(3);
    expect(results.every((e) => e.isError === false)).toBe(true);
    // Every result matches its use by id.
    expect(results.map((e) => e.id)).toEqual(uses.map((e) => e.id));
    // Read-only tools carry a one-line result summary — list_files included
    // (the Glob analog); Edit must never expose result content.
    expect(String(results[1].resultHead)).toContain("\\documentclass{article}");
    expect(String(results[1].resultHead)).not.toContain("\n");
    expect(String(results[0].resultHead)).toContain("main.tex");
    expect(results[2].resultHead).toBeUndefined();
    // tool_start fired as the calls began streaming.
    expect(events.filter((e) => e.type === "tool_start").map((e) => e.name)).toEqual([
      "list_files",
      "Read",
      "Edit",
    ]);
    // Streamed text arrived as deltas and completed blocks.
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.type === "text_final").map((e) => e.text)).toEqual([
      "Making the edit.",
      "All done.",
    ]);
    const end = events.at(-1)!;
    expect(end.type).toBe("turn_end");
    expect(end.isError).toBe(false);
    expect(typeof end.durationMs).toBe("number");
    expect(end.costUsd).toBeUndefined();
    expect(end.result).toBe("All done.");

    // Session: a fresh oai-… id was reported and the history was persisted.
    expect(session()).toMatch(/^oai-[0-9a-f]{16}$/);
    const historyFile = join(dataDir, "oai-sessions", `${session()}.json`);
    expect(existsSync(historyFile)).toBe(true);
    const history = JSON.parse(readFileSync(historyFile, "utf8"));
    expect(history[0]).toEqual({ role: "user", content: "Change the greeting" });
    expect(history.at(-1)).toMatchObject({ role: "assistant", content: "All done." });
    // No system message is stored — it is rebuilt per turn.
    expect(history.some((m: any) => m.role === "system")).toBe(false);

    // Requests: system prompt is the openai base (not the Claude append), the
    // model id travels verbatim, tools include the file tools.
    const { OPENAI_SYSTEM_PROMPT } = await import("../src/backends/openai.js");
    const first = mock.requests[0].body;
    expect(first.model).toBe("test-model");
    expect(first.stream).toBe(true);
    expect(first.messages[0]).toEqual({ role: "system", content: OPENAI_SYSTEM_PROMPT });
    expect(first.messages[1]).toEqual({ role: "user", content: "Change the greeting" });
    const toolNames = first.tools.map((t: any) => t.function.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["list_files", "read_file", "write_file", "edit_file", "compile_latex", "search_papers", "add_citation", "list_citations"]),
    );
    // No Authorization header without a key.
    expect(mock.requests[0].auth).toBeUndefined();
  });

  it("remembers earlier turns through the stored session history", async () => {
    const { agent, project } = await setup({ openaiApiKey: "sk-mock" });
    mock.queue = [{ kind: "text", text: "First answer." }];
    const turn1 = runCollected(agent, project, "First question");
    await turn1.done;
    const sid = turn1.session()!;
    expect(sid).toMatch(/^oai-/);
    expect(mock.requests[0].auth).toBe("Bearer sk-mock");

    mock.queue = [{ kind: "text", text: "Second answer." }];
    const turn2 = runCollected(agent, project, "Second question", { sessionId: sid });
    await turn2.done;
    // Resuming an existing session mints no new id…
    expect(turn2.session()).toBeUndefined();
    // …and the second request carried the whole first exchange.
    const msgs = mock.requests[1].body.messages;
    expect(msgs.map((m: any) => [m.role, m.content])).toEqual([
      ["system", expect.any(String)],
      ["user", "First question"],
      ["assistant", "First answer."],
      ["user", "Second question"],
    ]);
  });

  it.each(["review", "understand"] as const)(
    "%s mode drops the editing tools and blocks stray write calls",
    async (mode) => {
      const { agent, project, dir } = await setup();
      mock.queue = [
        { kind: "tools", calls: [{ name: "write_file", args: { path: "hack.tex", content: "nope" } }] },
        { kind: "text", text: "Understood, read-only." },
      ];
      const { events, done } = runCollected(agent, project, "Look at this", { mode });
      await done;

      const toolNames = mock.requests[0].body.tools.map((t: any) => t.function.name);
      expect(toolNames).not.toContain("write_file");
      expect(toolNames).not.toContain("edit_file");
      expect(toolNames).not.toContain("add_citation");
      expect(toolNames).toContain("read_file");
      // ask_user only talks to the user — it stays available in read-only modes.
      expect(toolNames).toContain("ask_user");

      const result = events.find((e) => e.type === "tool_result")!;
      expect(result.isError).toBe(true);
      expect(existsSync(join(dir, "hack.tex"))).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", isError: false });
    },
  );

  it("rejects path traversal in the file tools", async () => {
    const { agent, project, dir } = await setup();
    mock.queue = [
      {
        kind: "tools",
        calls: [
          { name: "read_file", args: { path: "../../../etc/passwd" } },
          { name: "write_file", args: { path: "../escaped.tex", content: "x" } },
          { name: "read_file", args: { path: "/etc/passwd" } },
        ],
      },
      { kind: "text", text: "ok" },
    ];
    const { events, done } = runCollected(agent, project, "escape!");
    await done;
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(3);
    expect(results.every((e) => e.isError === true)).toBe(true);
    expect(existsSync(join(dir, "..", "escaped.tex"))).toBe(false);
    // The model got told, in text, that the paths were rejected.
    const toolMsgs = mock.requests[1].body.messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs[0].content).toMatch(/invalid path/);
    expect(toolMsgs[1].content).toMatch(/inside the project/);
    expect(toolMsgs[2].content).toMatch(/outside the project/);
  });

  it("aborts mid-stream via interruptTurn and ends with an interrupted turn_end", async () => {
    const { agent, project } = await setup();
    mock.queue = [{ kind: "hang" }];
    const { events, done } = runCollected(agent, project, "never finishes");
    // Wait for the stream to start, then interrupt.
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "text_delta")) throw new Error("not streaming yet");
    });
    expect(agent.isTurnActive(project.id)).toBe(true);
    expect(agent.interruptTurn(project.id)).toBe(true);
    await done;
    expect(events.at(-1)).toMatchObject({ type: "turn_end", isError: false, interrupted: true });
    expect(agent.isTurnActive(project.id)).toBe(false);
  });

  it("tolerates malformed SSE lines", async () => {
    const { agent, project } = await setup();
    mock.queue = [{ kind: "text", text: "Solid answer.", malformed: true }];
    const { events, done } = runCollected(agent, project, "hi");
    await done;
    expect(events.filter((e) => e.type === "text_final").map((e) => e.text)).toEqual(["Solid answer."]);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", isError: false });
  });

  it("maps an HTTP error to error + turn_end isError", async () => {
    const { agent, project } = await setup();
    mock.queue = [{ kind: "error", status: 500, body: '{"error":{"message":"model exploded"}}' }];
    const { events, done } = runCollected(agent, project, "hi");
    await done;
    const err = events.find((e) => e.type === "error")!;
    expect(String(err.message)).toMatch(/500/);
    expect(String(err.message)).toMatch(/model exploded/);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", isError: true });
  });

  it("stops after 30 tool iterations", async () => {
    const { agent, project } = await setup();
    mock.loopCall = { name: "list_files", args: {} };
    const { events, done } = runCollected(agent, project, "loop forever");
    await done;
    expect(mock.requests.length).toBe(30);
    const err = events.find((e) => e.type === "error")!;
    expect(String(err.message)).toMatch(/30 tool iterations/);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", isError: true });
  });

  it("ask_user blocks on the pending question and feeds the answers back", async () => {
    const { agent, project } = await setup();
    const question = {
      question: "Which section should I improve?",
      header: "Section",
      options: [
        { label: "Introduction", description: "Rework the opening" },
        { label: "Conclusion", description: "Strengthen the ending" },
      ],
      multiSelect: false,
    };
    mock.queue = [
      { kind: "tools", calls: [{ name: "ask_user", args: { questions: [question] } }] },
      { kind: "text", text: "Focusing on the Introduction." },
    ];
    const { events, done } = runCollected(agent, project, "improve one section");
    const questions = await import("../src/questions.js");
    await vi.waitFor(() => {
      if (!questions.pendingQuestion(project.id)) throw new Error("no pending question yet");
    });
    // The question event streamed through the sink with the validated payload.
    const qEv = events.find((e) => e.type === "question")!;
    const pending = questions.pendingQuestion(project.id)!;
    expect(qEv).toEqual({
      type: "question",
      projectId: project.id,
      questionId: pending.questionId,
      questions: [question],
    });
    // The tool chip contract: SDK-side display name + first question as detail.
    expect(events.find((e) => e.type === "tool_use")).toMatchObject({
      name: "AskUserQuestion",
      detail: "Which section should I improve?",
    });

    const answers = { [question.question]: "Introduction" };
    expect(questions.answerQuestion(project.id, pending.questionId, answers)).toBe("ok");
    await done;

    expect(events.find((e) => e.type === "question_answered")).toEqual({
      type: "question_answered",
      questionId: pending.questionId,
      answers,
    });
    // The SECOND request carried the tool result with the answers JSON.
    const toolMsg = mock.requests[1].body.messages.filter((m: any) => m.role === "tool").at(-1);
    expect(JSON.parse(toolMsg.content)).toEqual({ answers });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", isError: false });
    expect(questions.pendingQuestion(project.id)).toBeUndefined();
    // ask_user is offered to the model (and stays available in review mode).
    expect(mock.requests[0].body.tools.map((t: any) => t.function.name)).toContain("ask_user");
  });

  it("dismissing ask_user tells the model the user declined", async () => {
    const { agent, project } = await setup();
    const question = {
      question: "Which tone should the abstract take?",
      header: "Tone",
      options: [
        { label: "Formal", description: "" },
        { label: "Accessible", description: "" },
      ],
      multiSelect: false,
    };
    mock.queue = [
      { kind: "tools", calls: [{ name: "ask_user", args: { questions: [question] } }] },
      { kind: "text", text: "Proceeding with my best judgment." },
    ];
    const { events, done } = runCollected(agent, project, "rewrite the abstract", { mode: "review" });
    const questions = await import("../src/questions.js");
    await vi.waitFor(() => {
      if (!questions.pendingQuestion(project.id)) throw new Error("no pending question yet");
    });
    const pending = questions.pendingQuestion(project.id)!;
    expect(questions.dismissQuestion(project.id, pending.questionId)).toBe("ok");
    await done;

    expect(events.find((e) => e.type === "question_dismissed")).toEqual({
      type: "question_dismissed",
      questionId: pending.questionId,
    });
    const toolMsg = mock.requests[1].body.messages.filter((m: any) => m.role === "tool").at(-1);
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed.declined).toBe(true);
    expect(parsed.note).toMatch(/best judgment/);
    // The dismissal is not an error; the turn simply continues.
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: false });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", isError: false });
    // Read-only review mode still offers ask_user (it only talks to the user).
    expect(mock.requests[0].body.tools.map((t: any) => t.function.name)).toContain("ask_user");
  });

  it("fails fast with a clear message when base URL or model is missing", async () => {
    const { agent, project, settings } = await setup();
    settings.saveSettings({ openaiBaseUrl: "" });
    let run = runCollected(agent, project, "hi");
    await run.done;
    expect(String(run.events.find((e) => e.type === "error")!.message)).toMatch(/base URL/);

    settings.saveSettings({ openaiBaseUrl: `http://127.0.0.1:${mock.port}/v1`, openaiModel: "" });
    run = runCollected(agent, project, "hi");
    await run.done;
    expect(String(run.events.find((e) => e.type === "error")!.message)).toMatch(/model/);
    expect(mock.requests).toHaveLength(0);
  });

  it("accumulates token usage across the turn's requests onto turn_end", async () => {
    const { agent, project } = await setup();
    mock.queue = [
      { kind: "tools", calls: [{ name: "list_files", args: {} }], usage: { prompt: 100, completion: 20 } },
      { kind: "text", text: "Done.", usage: { prompt: 150, completion: 30 } },
    ];
    const { events, done } = runCollected(agent, project, "count tokens");
    await done;
    const end = events.at(-1)!;
    expect(end).toMatchObject({
      type: "turn_end",
      isError: false,
      inputTokens: 250,
      outputTokens: 50,
      model: "test-model",
    });
    // Pricing stays unknown on this backend.
    expect(end.costUsd).toBeUndefined();
    // The requests asked the server for the usage chunk.
    expect(mock.requests[0].body.stream_options).toEqual({ include_usage: true });
  });

  it("omits token fields when the server reports no usage", async () => {
    const { agent, project } = await setup();
    mock.queue = [{ kind: "text", text: "No usage here." }];
    const { events, done } = runCollected(agent, project, "hi");
    await done;
    const end = events.at(-1)!;
    expect(end.type).toBe("turn_end");
    expect(end.inputTokens).toBeUndefined();
    expect(end.outputTokens).toBeUndefined();
  });

  it("uses the per-project model override verbatim", async () => {
    const { agent, config, project } = await setup();
    const updated = config.updateProject(project.id, { settings: { model: "project-model-x" } })!;
    mock.queue = [{ kind: "text", text: "ok" }];
    const { done } = runCollected(agent, updated, "hi");
    await done;
    expect(mock.requests[0].body.model).toBe("project-model-x");
  });
});

// ---- Unit: history cap, path validation, mappings ---------------------------

describe("openai backend units", () => {
  it("capHistory drops the oldest complete units and never orphans tool results", async () => {
    const { capHistory } = await import("../src/backends/openai.js");
    type M = import("../src/backends/openai.js").OaiMessage;
    const messages: M[] = [{ role: "user", content: "q" }];
    for (let i = 0; i < 24; i++) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "list_files", arguments: "{}" } }],
      });
      messages.push({ role: "tool", tool_call_id: `c${i}`, content: "files" });
    }
    messages.push({ role: "assistant", content: "done" });
    expect(messages.length).toBe(50);

    const capped = capHistory(messages, 40);
    expect(capped.length).toBeLessThanOrEqual(40);
    expect(capped[0].role).not.toBe("tool");
    // Every tool message still follows an assistant message that called it.
    for (let i = 0; i < capped.length; i++) {
      const m = capped[i];
      if (m.role === "tool") {
        const prev = capped
          .slice(0, i)
          .reverse()
          .find((x) => x.role === "assistant") as Extract<M, { role: "assistant" }> | undefined;
        expect(prev?.tool_calls?.some((c) => c.id === m.tool_call_id)).toBe(true);
      }
    }
    // The newest messages survive.
    expect(capped.at(-1)).toEqual({ role: "assistant", content: "done" });
    // Under the cap nothing changes.
    expect(capHistory(messages.slice(0, 10), 40)).toHaveLength(10);
  });

  it("resolveReadPath allows the project and context dirs, rejects everything else", async () => {
    const { resolveReadPath } = await import("../src/backends/openai.js");
    const dir = join(dataDir, "proj");
    const context = join(dataDir, "context-lib");
    mkdirSync(dir, { recursive: true });
    mkdirSync(context, { recursive: true });
    expect(resolveReadPath(dir, [context], "main.tex")).toBe(join(dir, "main.tex"));
    expect(resolveReadPath(dir, [context], "sub/x.tex")).toBe(join(dir, "sub", "x.tex"));
    expect(resolveReadPath(dir, [context], `${context}/notes.md`)).toBe(join(context, "notes.md"));
    expect(() => resolveReadPath(dir, [context], "../outside.tex")).toThrow(/invalid path/);
    expect(() => resolveReadPath(dir, [context], "/etc/passwd")).toThrow(/outside the project/);
    expect(() => resolveReadPath(dir, [], `${context}/notes.md`)).toThrow(/outside the project/);
    expect(() => resolveReadPath(dir, [context], "")).toThrow(/required/);
    expect(() => resolveReadPath(dir, [context], 42)).toThrow(/required/);
  });

  it("resolveWritePath confines writes to the project and shields .git and context dirs", async () => {
    const { resolveWritePath } = await import("../src/backends/openai.js");
    const dir = join(dataDir, "proj");
    const context = join(dataDir, "ctx");
    expect(resolveWritePath(dir, [context], "new.tex")).toBe(join(dir, "new.tex"));
    expect(() => resolveWritePath(dir, [context], "../evil.tex")).toThrow(/inside the project/);
    expect(() => resolveWritePath(dir, [context], "sub/../../evil.tex")).toThrow(/inside the project/);
    expect(() => resolveWritePath(dir, [context], `${context}/x.md`)).toThrow(/inside the project/);
    expect(() => resolveWritePath(dir, [context], ".git/config")).toThrow(/\.git/);
    expect(() => resolveWritePath(dir, [context], ".")).toThrow(/inside the project/);
  });

  it("edit_file demands an exact unique match", async () => {
    const { executeTool } = await import("../src/backends/openai.js");
    const dir = join(dataDir, "proj-edit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.tex"), "one two one\n");
    const ctx = {
      dir,
      contextDirs: [],
      readOnly: false,
      project: { id: "p" },
    } as any;
    // Not unique.
    let out = await executeTool(ctx, "edit_file", { path: "a.tex", old_string: "one", new_string: "1" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/more than once/);
    // Not found.
    out = await executeTool(ctx, "edit_file", { path: "a.tex", old_string: "three", new_string: "3" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/not found/);
    // Unique match works.
    out = await executeTool(ctx, "edit_file", { path: "a.tex", old_string: "two", new_string: "2" });
    expect(out.isError).toBe(false);
    expect(readFileSync(join(dir, "a.tex"), "utf8")).toBe("one 2 one\n");
    // Missing file points at write_file.
    out = await executeTool(ctx, "edit_file", { path: "b.tex", old_string: "x", new_string: "y" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/write_file/);
  });

  it("strips the Claude base append and keeps the per-turn blocks", async () => {
    const { buildOpenaiSystemPrompt, OPENAI_SYSTEM_PROMPT } = await import("../src/backends/openai.js");
    const { SYSTEM_APPEND } = await import("../src/agent.js");
    expect(buildOpenaiSystemPrompt(SYSTEM_APPEND)).toBe(OPENAI_SYSTEM_PROMPT);
    const withBlocks = SYSTEM_APPEND + "\n\nMode: Research — literature search and citations.";
    expect(buildOpenaiSystemPrompt(withBlocks)).toBe(
      OPENAI_SYSTEM_PROMPT + "\n\nMode: Research — literature search and citations.",
    );
  });

  it("maps model-facing tool names onto the shared event names", async () => {
    const { eventToolName } = await import("../src/backends/openai.js");
    expect(eventToolName("read_file")).toBe("Read");
    expect(eventToolName("write_file")).toBe("Write");
    expect(eventToolName("edit_file")).toBe("Edit");
    expect(eventToolName("add_citation")).toBe("mcp__blattbot__add_citation");
    expect(eventToolName("compile_latex")).toBe("mcp__blattbot__compile_latex");
    expect(eventToolName("something_else")).toBe("something_else");
  });

  it("session ids are namespaced and validated", async () => {
    const { isOaiSessionId, loadHistory } = await import("../src/backends/openai.js");
    expect(isOaiSessionId("oai-0123456789abcdef")).toBe(true);
    expect(isOaiSessionId("d9c2…-sdk-uuid")).toBe(false);
    expect(isOaiSessionId("oai-../../etc/passwd")).toBe(false);
    expect(() => loadHistory("../../escape")).toThrow(/invalid session id/);
  });
});

// ---- Settings & model resolution --------------------------------------------

describe("backend settings", () => {
  it("publicSettings exposes the backend fields but redacts the openai key", async () => {
    const settings = await import("../src/settings.js");
    settings.saveSettings({
      backend: "openai",
      openaiBaseUrl: "http://127.0.0.1:9999/v1",
      openaiApiKey: "sk-secret",
      openaiModel: "m1",
    });
    const pub = settings.publicSettings() as any;
    expect(pub.backend).toBe("openai");
    expect(pub.openaiBaseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(pub.openaiModel).toBe("m1");
    expect(pub.hasOpenaiApiKey).toBe(true);
    expect(pub.openaiApiKey).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("resolveBackendModel: aliases for claude, verbatim for openai, override applies to both", async () => {
    const { resolveBackendModel } = await import("../src/agent.js");
    const { DEFAULT_SETTINGS } = await import("../src/settings.js");
    const base = { ...DEFAULT_SETTINGS, model: "sonnet", openaiModel: "llama-3.3-70b" };
    // claude (default backend): aliases resolve.
    expect(resolveBackendModel(undefined, base)).toBe("claude-sonnet-5");
    expect(resolveBackendModel({ settings: { model: "fable" } }, base)).toBe("claude-fable-5");
    // openai: verbatim, no alias mapping, override wins.
    const oai = { ...base, backend: "openai" as const };
    expect(resolveBackendModel(undefined, oai)).toBe("llama-3.3-70b");
    expect(resolveBackendModel({ settings: { model: "fable" } }, oai)).toBe("fable");
    expect(resolveBackendModel({ settings: {} }, oai)).toBe("llama-3.3-70b");
    // openai with nothing configured resolves to "".
    expect(resolveBackendModel(undefined, { ...DEFAULT_SETTINGS, backend: "openai" })).toBe("");
  });

  it("activeBackendId treats anything but 'openai' as claude", async () => {
    const { activeBackendId, BACKENDS } = await import("../src/agent.js");
    const { DEFAULT_SETTINGS } = await import("../src/settings.js");
    expect(activeBackendId({ ...DEFAULT_SETTINGS })).toBe("claude");
    expect(activeBackendId({ ...DEFAULT_SETTINGS, backend: "claude" })).toBe("claude");
    expect(activeBackendId({ ...DEFAULT_SETTINGS, backend: "openai" })).toBe("openai");
    expect(BACKENDS.claude.id).toBe("claude");
    expect(BACKENDS.openai.id).toBe("openai");
  });
});
