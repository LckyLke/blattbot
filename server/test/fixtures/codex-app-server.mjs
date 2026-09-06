// Scripted Codex app-server peer. Runs as a real child process, without a model.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const scenario = process.env.BLATTBOT_TEST_CODEX_SCENARIO || "edit";
const threadId = "01900000-0000-7000-8000-000000000001";
const pending = new Map();
let nextId = 100;
let resumed = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const note = (method, params) => send({ method, params: { threadId, ...params } });
async function call(tool, args) {
  const id = nextId++;
  const result = new Promise((resolve) => pending.set(id, resolve));
  send({ id, method: "item/tool/call", params: { threadId, turnId: "turn-1", callId: `call-${id}`, tool, arguments: args } });
  return result;
}
const tokens = (input, output) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
async function turn(p) {
  if (scenario === "exit") process.exit(7);
  if (scenario === "hang") { setInterval(() => {}, 1000); return; }
  if (scenario === "error") { note("turn/completed", { turn: { id: "turn-1", status: "failed", error: { message: "mock provider failure" } } }); return; }
  if (scenario === "question") {
    await call("ask_user", { questions: [{ question: "Which style?", header: "Style", options: [
      { label: "Concise", description: "Keep it short" }, { label: "Detailed", description: "Include context" },
    ] }] });
  } else if (scenario !== "oneshot") {
    await call("read_file", { path: "main.tex" });
    await call("write_file", { path: "main.tex", content: "Revised manuscript.\n" });
    await call("compile_latex", {});
    if (scenario === "readonly") await call("add_citation", { ref: "10.mock/example" });
  }
  note("thread/tokenUsage/updated", { tokenUsage: {
    total: tokens(resumed ? 500 : 100, resumed ? 70 : 20), last: tokens(100, 20), modelContextWindow: 200000,
  } });
  note("item/agentMessage/delta", { itemId: "text-1", delta: "All " });
  note("item/agentMessage/delta", { itemId: "text-1", delta: "done." });
  note("item/completed", { item: { type: "agentMessage", id: "text-1", text: "All done." } });
  note("turn/completed", { turn: { id: "turn-1", status: "completed" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (process.env.BLATTBOT_TEST_CODEX_LOG) appendFileSync(process.env.BLATTBOT_TEST_CODEX_LOG, line + "\n");
  if (!m.method) { pending.get(m.id)?.(m.result ?? m.error); pending.delete(m.id); return; }
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize": reply({ userAgent: "codex/mock" }); break;
    case "initialized": break;
    case "config/read": reply({ config: { model: "codex-test-model", mcp_servers: { "private.server": { command: "unused" } } } }); break;
    case "account/read": reply({ account: scenario === "loggedout" ? null : { type: "chatgpt" }, requiresOpenaiAuth: true }); break;
    case "model/list": reply({ data: [{ model: "codex-test-model", displayName: "Test Codex", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null }); break;
    case "thread/resume":
      resumed = true;
      note("thread/tokenUsage/updated", { tokenUsage: { total: tokens(400, 50), last: tokens(80, 10) } });
      reply({ thread: { id: threadId }, model: "codex-test-model" }); break;
    case "thread/start": reply({ thread: { id: threadId }, model: "codex-test-model" }); break;
    case "turn/start": reply({ turn: { id: "turn-1" } }); void turn(m.params); break;
    default: send({ id: m.id, error: { message: `Unexpected request: ${m.method}` } });
  }
});
