/**
 * Model-related query options of the Claude backend and the refusal notices
 * — the Fable 5.1 plumbing: effort passthrough, the automatic Opus 5
 * fallback behind a Fable-family primary, and the chat notices for the
 * SDK's refusal system messages (a safety-classifier decline must never end
 * a turn silently).
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  contextOfUsage,
  contextWindowOf,
  extractResultUsage,
  makeFenceHook,
  makeOnUserDialog,
  refusalChoice,
  refusalDialogQuestion,
  refusalNotice,
  sdkEventNotice,
  turnModelOptions,
} from "../src/backends/claude.js";
import { answerQuestion, dismissQuestion } from "../src/questions.js";
import { isEffortLevel, isFableFamily, resolveFallbackModel } from "../src/backends/types.js";
import { projectDir } from "../src/config.js";

describe("turnModelOptions", () => {
  it("passes only the model when nothing else is configured (non-Fable)", () => {
    expect(turnModelOptions("claude-sonnet-5", { effort: "", fallbackModel: "" })).toEqual({
      model: "claude-sonnet-5",
    });
  });

  it("adds Opus 5 as the automatic fallback behind Fable 5.1", () => {
    expect(turnModelOptions("claude-fable-5-1", { effort: "", fallbackModel: "" })).toEqual({
      model: "claude-fable-5-1",
      fallbackModel: "claude-opus-5",
    });
  });

  it("passes a configured effort level through and drops junk", () => {
    expect(turnModelOptions("claude-fable-5-1", { effort: "xhigh", fallbackModel: "" }).effort).toBe("xhigh");
    expect(turnModelOptions("claude-fable-5-1", { effort: "extreme" as any, fallbackModel: "" }).effort).toBeUndefined();
  });

  it("honours a configured fallback (aliases resolved) and 'none'", () => {
    expect(turnModelOptions("claude-fable-5-1", { effort: "", fallbackModel: "sonnet" }).fallbackModel).toBe(
      "claude-sonnet-5",
    );
    expect(turnModelOptions("claude-fable-5-1", { effort: "", fallbackModel: "none" }).fallbackModel).toBeUndefined();
    // A fallback equal to the primary is pointless — dropped.
    expect(turnModelOptions("claude-opus-5", { effort: "", fallbackModel: "opus" }).fallbackModel).toBeUndefined();
  });
});

describe("model helpers", () => {
  it("recognises the Fable family (Fable and Mythos ids) only", () => {
    expect(isFableFamily("claude-fable-5-1")).toBe(true);
    expect(isFableFamily("claude-fable-5")).toBe(true);
    expect(isFableFamily("claude-mythos-5-1")).toBe(true);
    expect(isFableFamily("claude-opus-5")).toBe(false);
    expect(isFableFamily("fable")).toBe(false); // aliases are resolved before this runs
  });

  it("resolveFallbackModel: configured > automatic > none", () => {
    expect(resolveFallbackModel("claude-sonnet-5", "")).toBeUndefined();
    expect(resolveFallbackModel("claude-fable-5", "")).toBe("claude-opus-5");
    expect(resolveFallbackModel("claude-sonnet-5", "haiku")).toBe("claude-haiku-4-5-20251001");
    expect(resolveFallbackModel("claude-fable-5-1", " OFF ")).toBeUndefined();
  });

  it("isEffortLevel accepts the five SDK levels only", () => {
    for (const l of ["low", "medium", "high", "xhigh", "max"]) expect(isEffortLevel(l)).toBe(true);
    expect(isEffortLevel("")).toBe(false);
    expect(isEffortLevel("HIGH")).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
  });
});

describe("refusalNotice", () => {
  it("reports a fallback retry with the category and where the chat continues", () => {
    const n = refusalNotice({
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-fable-5-1",
      fallback_model: "claude-opus-5",
      api_refusal_category: "cyber",
      api_refusal_explanation: "The request touched exploit development.",
    });
    expect(n?.type).toBe("notice");
    expect(n?.tone).toBe("warn");
    expect(n?.text).toContain("claude-fable-5-1 declined this request (category: cyber)");
    expect(n?.text).toContain("The request touched exploit development.");
    expect(n?.text).toContain("continued on claude-opus-5; the rest of this chat runs there too.");
  });

  it("scopes a local (subagent) fallback to that step", () => {
    const n = refusalNotice({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "local",
      original_model: "claude-fable-5-1",
      fallback_model: "claude-opus-5",
      api_refusal_category: null,
    });
    expect(n?.text).toContain("declined this request.");
    expect(n?.text).toContain("for this step only.");
  });

  it("reports a refusal without fallback as an error naming the setting", () => {
    const n = refusalNotice({
      type: "system",
      subtype: "model_refusal_no_fallback",
      original_model: "claude-fable-5-1",
      content: "…",
    });
    expect(n?.tone).toBe("error");
    expect(n?.text).toContain("No fallback model is configured (Settings → Agent)");
  });

  it("ignores every other message", () => {
    expect(refusalNotice({ type: "system", subtype: "init" })).toBeUndefined();
    expect(refusalNotice({ type: "assistant" })).toBeUndefined();
    expect(refusalNotice(undefined)).toBeUndefined();
  });
});

describe("extractResultUsage models", () => {
  it("lists the models that served the turn from modelUsage", () => {
    const r = extractResultUsage({
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { "claude-fable-5-1": { costUSD: 0.4 }, "claude-opus-5": { costUSD: 0.1 } },
    });
    expect(r.models).toEqual(["claude-fable-5-1", "claude-opus-5"]);
    expect(r.costUsd).toBe(0.5);
  });

  it("omits models when the SDK reports none", () => {
    expect(extractResultUsage({ usage: { input_tokens: 1, output_tokens: 1 } }).models).toBeUndefined();
    expect(extractResultUsage({ modelUsage: {} }).models).toBeUndefined();
  });

  it("collapses dated and undated keys of one model through canonicalModel", () => {
    // Observed live: the CLI keyed one haiku turn under both spellings.
    const r = extractResultUsage({
      modelUsage: {
        "claude-haiku-4-5-20251001": { costUSD: 0.01, canonicalModel: "claude-haiku-4-5" },
        "claude-haiku-4-5": { costUSD: 0.01, canonicalModel: "claude-haiku-4-5" },
      },
    });
    expect(r.models).toEqual(["claude-haiku-4-5"]);
  });
});

describe("makeFenceHook (PreToolUse)", () => {
  const hookOpts = { signal: new AbortController().signal };

  it("denies a write outside the project with the fence's reason", async () => {
    const hook = makeFenceHook("proj-fence");
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/outside.txt", content: "x" },
        tool_use_id: "tu-1",
        session_id: "s",
        transcript_path: "/dev/null",
        cwd: projectDir("proj-fence"),
      } as any,
      "tu-1",
      hookOpts,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/inside the project working tree/),
      },
    });
  });

  it("has no opinion on an in-project write or on other hook events", async () => {
    const hook = makeFenceHook("proj-fence");
    const inside = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(projectDir("proj-fence"), "main.tex"), old_string: "a", new_string: "b" },
        tool_use_id: "tu-2",
        session_id: "s",
        transcript_path: "/dev/null",
        cwd: projectDir("proj-fence"),
      } as any,
      "tu-2",
      hookOpts,
    );
    expect(inside).toEqual({});
    const other = await hook(
      { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: {}, tool_response: {} } as any,
      "tu-3",
      hookOpts,
    );
    expect(other).toEqual({});
  });

  it("allows reads inside an attached context directory only", async () => {
    const hook = makeFenceHook("proj-fence", ["/srv/context"]);
    const ok = await hook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/srv/context/notes.md" } } as any,
      undefined,
      hookOpts,
    );
    expect(ok).toEqual({});
    const blocked = (await hook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/srv/elsewhere/notes.md" } } as any,
      undefined,
      hookOpts,
    )) as any;
    expect(blocked.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("refusal dialog (question card)", () => {
  it("builds one single-select question naming both models and the category", () => {
    const q = refusalDialogQuestion({
      originalModel: "claude-fable-5-1",
      fallbackModel: "claude-opus-5",
      apiRefusalCategory: "bio",
      guidanceText: "Consider rephrasing.",
    });
    expect(q.header).toBe("Declined");
    expect(q.multiSelect).toBe(false);
    expect(q.question).toContain("claude-fable-5-1 declined this request (category: bio). Consider rephrasing.");
    expect(q.options.map((o) => o.label)).toEqual(["Retry on claude-opus-5", "Stop this turn"]);
  });

  it("maps the answer to the CLI's result values", () => {
    expect(refusalChoice("Retry on claude-opus-5")).toBe("retry_fallback");
    expect(refusalChoice("retry please")).toBe("retry_fallback");
    expect(refusalChoice("Stop this turn")).toBe("edit_prompt");
    expect(refusalChoice(undefined)).toBe("edit_prompt");
  });

  it("shows the card, waits, and answers retry_fallback / edit_prompt / cancelled", async () => {
    const events: any[] = [];
    const dialog = makeOnUserDialog("proj-refusal", (e) => events.push(e), new AbortController().signal);
    const opts = { signal: new AbortController().signal, requestId: "r1" };
    const payload = { originalModel: "claude-fable-5-1", fallbackModel: "claude-opus-5", apiRefusalCategory: null };

    // Retry: the answer arrives through the question route's settle function.
    const p1 = dialog({ dialogKind: "refusal_fallback_prompt", payload }, opts);
    await new Promise((r) => setTimeout(r, 0));
    const shown = events.find((e) => e.type === "question");
    expect(shown).toBeTruthy();
    expect(shown.questions[0].header).toBe("Declined");
    answerQuestion("proj-refusal", shown.questionId, { [shown.questions[0].question]: "Retry on claude-opus-5" });
    await expect(p1).resolves.toEqual({ behavior: "completed", result: "retry_fallback" });

    // Skip → edit_prompt (the turn ends; the user rephrases).
    events.length = 0;
    const p2 = dialog({ dialogKind: "refusal_fallback_prompt", payload }, opts);
    await new Promise((r) => setTimeout(r, 0));
    dismissQuestion("proj-refusal", events.find((e) => e.type === "question").questionId);
    await expect(p2).resolves.toEqual({ behavior: "completed", result: "edit_prompt" });

    // A kind we never declared: cancelled, no card.
    events.length = 0;
    await expect(dialog({ dialogKind: "something_else", payload: {} }, opts)).resolves.toEqual({ behavior: "cancelled" });
    expect(events).toEqual([]);
  });
});

describe("sdkEventNotice", () => {
  it("warns once per turn about an approaching rate limit, errors on rejection", () => {
    const seen = new Set<string>();
    const warn = sdkEventNotice(
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" } },
      seen,
    );
    expect(warn?.tone).toBe("warn");
    expect(warn?.text).toContain("five hour window");
    expect(sdkEventNotice({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }, seen)).toBeUndefined();
    expect(sdkEventNotice({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, seen)).toBeUndefined();
    expect(sdkEventNotice({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, seen)?.tone).toBe("error");
  });

  it("explains API retries and compaction", () => {
    const seen = new Set<string>();
    const retry = sdkEventNotice(
      { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 2000, error_status: 529 },
      seen,
    );
    expect(retry?.text).toBe("API request failed (HTTP 529) — retrying in 2.0s (attempt 2/10).");
    const compact = sdkEventNotice(
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 24_000 } },
      seen,
    );
    expect(compact?.text).toContain("Context compacted (automatic: 180k → 24k tokens)");
    expect(sdkEventNotice({ type: "system", subtype: "status", compact_result: "failed", compact_error: "boom" }, seen)?.text).toBe(
      "Context compaction failed: boom.",
    );
    expect(sdkEventNotice({ type: "system", subtype: "init" }, seen)).toBeUndefined();
    expect(sdkEventNotice({ type: "assistant" }, seen)).toBeUndefined();
  });
});

describe("context helpers", () => {
  it("sums a response's input, cache reads and cache writes", () => {
    expect(contextOfUsage({ input_tokens: 100, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500 })).toBe(20_600);
    expect(contextOfUsage({ input_tokens: 0 })).toBeUndefined();
    expect(contextOfUsage(null)).toBeUndefined();
  });

  it("takes the largest context window the SDK reports", () => {
    expect(contextWindowOf({ a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 } })).toBe(1_000_000);
    expect(contextWindowOf({})).toBeUndefined();
  });
});
