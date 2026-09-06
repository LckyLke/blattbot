/** Codex owns reasoning and conversation history; BlattBot owns project tools. */
import { loadSettings, type Settings } from "../settings.js";
import { CodexClient, codexWorkspace } from "./codex-client.js";
import {
  buildOpenaiSystemPrompt, eventToolName, executeTool, OPENAI_SYSTEM_PROMPT,
  summarizeArgs, toolDefinitions,
} from "./openai.js";
import { resultHead, type AgentBackend, type BackendTurnContext } from "./types.js";

export const CODEX_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const CODEX_SYSTEM_PROMPT = OPENAI_SYSTEM_PROMPT;
export const isCodexSessionId = (id: string) => /^codex-[a-zA-Z0-9-]+$/.test(id);

export function codexTools() {
  // Keep the catalog stable across resume and mode changes. executeTool and
  // the current turn's allowlist independently reject edits in read-only modes.
  return toolDefinitions(false).map(({ function: f }) => ({
    type: "function", name: f.name, description: f.description, inputSchema: f.parameters,
  }));
}

interface CodexRun {
  prompt: string;
  instructions: string;
  settings: Settings;
  signal: AbortSignal;
  model: string;
  ctx?: BackendTurnContext;
}

async function run({ prompt, instructions, settings, signal, model, ctx }: CodexRun): Promise<string> {
  signal.throwIfAborted();
  const client = new CodexClient();
  const started = Date.now();
  let threadId = "";
  let turnId = "";
  let actualModel = model;
  let finalText = "";
  let usage: any;
  let initialUsage: any;
  let contextTokens: number | undefined;
  let turnStarted = false;
  let settled = false;
  let toolQueue: Promise<unknown> = Promise.resolve();
  const emit = ctx?.emit ?? (() => {});
  const allowed = new Set(ctx ? toolDefinitions(ctx.readOnly).map((t) => t.function.name) : []);
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Initialization can fail before done is awaited.
  void done.catch(() => {});
  const fail = (e: Error) => { if (!settled) { settled = true; rejectDone(e); } };
  client.onFailure = fail;
  const abort = () => { fail(new Error("Codex turn interrupted")); client.close(); };
  signal.addEventListener("abort", abort, { once: true });

  client.onRequest = async (method, p) => {
    if (method !== "item/tool/call") {
      // Never grant native command, file, or permission escalation requests.
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        return { decision: "decline" };
      }
      throw new Error(`Use BlattBot's provided tools; ${method} is unavailable.`);
    }
    const work = toolQueue.then(async () => {
      signal.throwIfAborted();
      if (settled || !ctx || p.threadId !== threadId || !allowed.has(p.tool)) {
        return { success: false, contentItems: [{ type: "inputText", text: "This tool is unavailable in the current mode." }] };
      }
      const name = eventToolName(p.tool);
      const id = p.callId;
      emit({ type: "tool_start", name });
      emit({ type: "tool_use", id, name, detail: summarizeArgs(p.tool, p.arguments, ctx.dir) });
      const result = await executeTool(ctx, p.tool, p.arguments);
      signal.throwIfAborted();
      emit({ type: "tool_result", id, isError: result.isError, resultHead: resultHead(name, result.content) });
      return { success: !result.isError, contentItems: [{ type: "inputText", text: result.content }] };
    });
    toolQueue = work.catch(() => {});
    return work;
  };

  client.onNotification = (method, p) => {
    if (settled || (p.threadId && threadId && p.threadId !== threadId)) return;
    if (method === "thread/tokenUsage/updated") {
      if (!turnStarted) initialUsage = p.tokenUsage?.total;
      else {
        usage = p.tokenUsage;
        if (!initialUsage && p.tokenUsage?.total && p.tokenUsage?.last) {
          initialUsage = Object.fromEntries(["inputTokens", "outputTokens"].map((key) =>
            [key, Math.max(0, p.tokenUsage.total[key] - p.tokenUsage.last[key])],
          ));
        }
        const tokens = p.tokenUsage?.last?.inputTokens;
        if (typeof tokens === "number") contextTokens = Math.max(contextTokens ?? 0, tokens);
      }
    } else if (method === "item/agentMessage/delta") {
      emit({ type: "text_delta", text: p.delta ?? "" });
    } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      emit({ type: "thinking" });
    } else if (method === "item/completed" && p.item?.type === "agentMessage") {
      const text = p.item.text ?? "";
      finalText += (finalText ? "\n\n" : "") + text;
      emit({ type: "text_final", text });
    } else if (method === "error") {
      const message = p.error?.message ?? "Codex reported an error";
      if (p.willRetry) emit({ type: "notice", tone: "info", text: message });
      else fail(new Error(message));
    } else if (method === "turn/completed" && turnStarted && (!turnId || p.turn?.id === turnId)) {
      if (p.turn?.status === "failed") fail(new Error(p.turn.error?.message ?? "Codex turn failed"));
      else if (p.turn?.status === "interrupted") fail(new Error("Codex turn interrupted"));
      else { settled = true; resolveDone(); }
    }
  };

  try {
    await client.initialize();
    signal.throwIfAborted();
    const config = await client.threadConfig();
    const common = {
      cwd: codexWorkspace(), sandbox: "read-only", approvalPolicy: "never",
      config, baseInstructions: instructions,
      developerInstructions: "Use only the provided BlattBot tools for project access. Native shell, patch, and external integration tools are unavailable.",
      ...(model ? { model } : {}),
    };
    const previous = ctx?.session.sessionId;
    const resume = previous && isCodexSessionId(previous) ? previous.slice(6) : undefined;
    const response = resume
      ? await client.request("thread/resume", { ...common, threadId: resume })
      : await client.request("thread/start", { ...common, dynamicTools: ctx ? codexTools() : [], ephemeral: !ctx });
    threadId = response.thread.id;
    actualModel = response.model || model;
    if (ctx && !resume) {
      ctx.session.onSessionId?.(`codex-${threadId}`);
      if (previous) emit({ type: "notice", tone: "info", text: "Started a Codex conversation. Earlier messages from the other backend remain in this chat, but are not part of Codex's memory." });
    }
    signal.throwIfAborted();
    turnStarted = true;
    emit({ type: "thinking" });
    const turn = await client.request("turn/start", {
      threadId,
      input: [
        { type: "text", text: prompt, text_elements: [] },
        ...(ctx?.attachments ?? []).map((a) => ({ type: "localImage", path: a.path })),
      ],
      ...(settings.codexEffort ? { effort: settings.codexEffort } : {}),
    });
    turnId = turn.turn.id;
    await done;
    await toolQueue;
    signal.throwIfAborted();
    const total = usage?.total;
    // Codex totals are cumulative across the thread; subtract the resume
    // baseline so project usage doesn't count previous turns twice.
    const delta = (key: string) => typeof total?.[key] === "number"
      ? Math.max(0, total[key] - (initialUsage?.[key] ?? 0)) : undefined;
    emit({
      type: "turn_end", isError: false, model: actualModel || undefined,
      models: actualModel ? [actualModel] : [], inputTokens: delta("inputTokens"),
      outputTokens: delta("outputTokens"), contextTokens,
      contextWindow: usage?.modelContextWindow ?? undefined, durationMs: Date.now() - started,
    });
    return finalText;
  } finally {
    settled = true;
    signal.removeEventListener("abort", abort);
    client.close();
    // Drain in-flight host tools before the dispatcher releases the project.
    await toolQueue;
  }
}

export const codexBackend: AgentBackend = {
  id: "codex", label: "Codex", description: "Runs the local Codex CLI with your existing login, persistent conversations, and BlattBot's project tools.",
  async runTurn(ctx) {
    await run({ ctx, prompt: ctx.prompt, instructions: buildOpenaiSystemPrompt(ctx.systemAppend),
      settings: ctx.settings, signal: ctx.signal, model: ctx.model });
  },
};

export function runOneShotCodex(prompt: string, settings = loadSettings()): Promise<string> {
  return run({ prompt, instructions: "Answer the user's request directly in text. No tools are available.",
    settings, signal: AbortSignal.timeout(120_000), model: settings.codexModel.trim() });
}
