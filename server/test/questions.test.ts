/**
 * Mid-turn question tests: input validation, the pending-question registry,
 * the shared ask flow (events + abort), the Claude backend's canUseTool
 * factory, and the transcript round-trip of question events. No SDK process
 * and no network — everything resolves through the in-process registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-questions-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

const QUESTION = {
  question: "Which section should I improve?",
  header: "Section",
  options: [
    { label: "Introduction", description: "Rework the opening" },
    { label: "Conclusion", description: "Strengthen the ending" },
  ],
  multiSelect: false,
};

type Ev = { type: string; [key: string]: unknown };

describe("validateQuestions", () => {
  it("accepts and normalizes a clean question set", async () => {
    const { validateQuestions } = await import("../src/questions.js");
    expect(validateQuestions([QUESTION])).toEqual([QUESTION]);
  });

  it("clamps counts and the header, defaults multiSelect, drops junk options", async () => {
    const { validateQuestions } = await import("../src/questions.js");
    const many = Array.from({ length: 6 }, (_, i) => ({
      question: `Q${i}?`,
      header: "An overlong header chip",
      options: [
        { label: " A ", description: 7 },
        { label: "B" },
        { label: "" },
        { label: "C", description: "c" },
        { label: "D", description: "d" },
        { label: "E", description: "e" },
      ],
    }));
    const out = validateQuestions(many);
    expect(out).toHaveLength(4);
    expect(out[0].header).toBe("An overlong ");
    expect(out[0].header.length).toBeLessThanOrEqual(12);
    expect(out[0].multiSelect).toBe(false);
    // The empty-label option is dropped; the rest cap at 4; fields normalize.
    expect(out[0].options).toHaveLength(4);
    expect(out[0].options[0]).toEqual({ label: "A", description: "" });
    expect(out[0].options[1]).toEqual({ label: "B", description: "" });
  });

  it("falls back to a generic header and rejects unrenderable input", async () => {
    const { validateQuestions } = await import("../src/questions.js");
    const out = validateQuestions([{ ...QUESTION, header: "   " }]);
    expect(out[0].header).toBe("Question");
    expect(() => validateQuestions([])).toThrow(/non-empty/);
    expect(() => validateQuestions("nope")).toThrow(/non-empty/);
    expect(() => validateQuestions([{ ...QUESTION, question: "  " }])).toThrow(/no question text/);
    expect(() =>
      validateQuestions([{ ...QUESTION, options: [{ label: "only one", description: "" }] }]),
    ).toThrow(/at least 2/);
  });
});

describe("validateAnswers", () => {
  const KEY = QUESTION.question;

  it("accepts a matching record and clamps long answers", async () => {
    const { validateAnswers, MAX_ANSWER_CHARS } = await import("../src/questions.js");
    expect(validateAnswers({ [KEY]: "A, B" }, [QUESTION])).toEqual({ [KEY]: "A, B" });
    const long = validateAnswers({ [KEY]: "x".repeat(MAX_ANSWER_CHARS + 50) }, [QUESTION]);
    expect(long[KEY]).toHaveLength(MAX_ANSWER_CHARS);
  });

  it("rejects non-objects, non-string values, and empty records", async () => {
    const { validateAnswers } = await import("../src/questions.js");
    expect(() => validateAnswers(null, [QUESTION])).toThrow(/object/);
    expect(() => validateAnswers(["a"], [QUESTION])).toThrow(/object/);
    expect(() => validateAnswers({ [KEY]: 3 }, [QUESTION])).toThrow(/string/);
    expect(() => validateAnswers({}, [QUESTION])).toThrow(/not be empty|missing answer/);
  });

  it("rejects keys that are not the pending question's texts", async () => {
    const { validateAnswers } = await import("../src/questions.js");
    // A key unrelated to the question set would be injected verbatim into the
    // model conversation — reject the whole record.
    expect(() => validateAnswers({ [KEY]: "A", extra: "smuggled" }, [QUESTION])).toThrow(
      /unknown question: extra/,
    );
    expect(() => validateAnswers({ ["y".repeat(2000)]: "x" }, [QUESTION])).toThrow(
      /unknown question/,
    );
  });

  it("requires every single-select answered; an empty multi-select may be omitted", async () => {
    const { validateAnswers } = await import("../src/questions.js");
    const multi = { ...QUESTION, question: "Which topics?", multiSelect: true };
    expect(() => validateAnswers({ "Which topics?": "A" }, [QUESTION, multi])).toThrow(
      /missing answer for: Which section/,
    );
    expect(() => validateAnswers({ [KEY]: "  " }, [QUESTION])).toThrow(/missing answer/);
    // The multi-select key may be absent — only the single-select is required.
    expect(validateAnswers({ [KEY]: "A" }, [QUESTION, multi])).toEqual({ [KEY]: "A" });
  });
});

describe("pending-question registry", () => {
  it("registers, exposes, answers, and cleans up a question", async () => {
    const q = await import("../src/questions.js");
    const { pending, resolution } = q.registerQuestion("proj-1", [QUESTION]);
    expect(pending.questionId).toMatch(/^q-[0-9a-f]{8}$/);
    expect(q.pendingQuestion("proj-1")).toBe(pending);

    const answers = { [QUESTION.question]: "Introduction" };
    expect(q.answerQuestion("proj-1", pending.questionId, answers)).toBe("ok");
    await expect(resolution).resolves.toEqual({ kind: "answered", answers });
    expect(q.pendingQuestion("proj-1")).toBeUndefined();
  });

  it("double-answering reports 'resolved', unknown ids report 'unknown'", async () => {
    const q = await import("../src/questions.js");
    const { pending } = q.registerQuestion("proj-1", [QUESTION]);
    expect(q.answerQuestion("proj-1", "q-doesnotexist", { a: "b" })).toBe("unknown");
    expect(q.answerQuestion("proj-1", pending.questionId, { a: "b" })).toBe("ok");
    // Both answering and dismissing again hit the settled id.
    expect(q.answerQuestion("proj-1", pending.questionId, { a: "b" })).toBe("resolved");
    expect(q.dismissQuestion("proj-1", pending.questionId)).toBe("resolved");
  });

  it("a question settled under another project stays 'unknown' here (404, not 410)", async () => {
    const q = await import("../src/questions.js");
    const { pending } = q.registerQuestion("proj-B", [QUESTION]);
    expect(q.answerQuestion("proj-B", pending.questionId, { a: "b" })).toBe("ok");
    // proj-B remembers the settle; proj-A never saw the id at all.
    expect(q.answerQuestion("proj-B", pending.questionId, { a: "b" })).toBe("resolved");
    expect(q.answerQuestion("proj-A", pending.questionId, { a: "b" })).toBe("unknown");
    expect(q.dismissQuestion("proj-A", pending.questionId)).toBe("unknown");
    expect(q.questionStatus("proj-B", pending.questionId)).toBe("resolved");
    expect(q.questionStatus("proj-A", pending.questionId)).toBe("unknown");
  });

  it("questionStatus reports pending for the live question", async () => {
    const q = await import("../src/questions.js");
    const { pending } = q.registerQuestion("proj-1", [QUESTION]);
    expect(q.questionStatus("proj-1", pending.questionId)).toBe("pending");
    expect(q.questionStatus("proj-1", "q-doesnotexist")).toBe("unknown");
  });

  it("dismiss and abort resolve their kinds; only one question per project", async () => {
    const q = await import("../src/questions.js");
    const first = q.registerQuestion("proj-1", [QUESTION]);
    expect(() => q.registerQuestion("proj-1", [QUESTION])).toThrow(/already pending/);
    // Another project is unaffected.
    const other = q.registerQuestion("proj-2", [QUESTION]);
    expect(q.dismissQuestion("proj-1", first.pending.questionId)).toBe("ok");
    await expect(first.resolution).resolves.toEqual({ kind: "dismissed" });
    q.abortQuestion("proj-2");
    await expect(other.resolution).resolves.toEqual({ kind: "aborted" });
    // Aborting with nothing pending is a no-op.
    q.abortQuestion("proj-2");
    expect(q.pendingQuestion("proj-2")).toBeUndefined();
  });
});

describe("askUserQuestions flow", () => {
  it("emits question → question_answered around the user's answer", async () => {
    const q = await import("../src/questions.js");
    const events: Ev[] = [];
    const flow = q.askUserQuestions("proj-1", (e) => events.push(e), [QUESTION]);
    const pending = q.pendingQuestion("proj-1")!;
    expect(events[0]).toEqual({
      type: "question",
      projectId: "proj-1",
      questionId: pending.questionId,
      questions: [QUESTION],
    });
    const answers = { [QUESTION.question]: "Conclusion" };
    q.answerQuestion("proj-1", pending.questionId, answers);
    await expect(flow).resolves.toEqual({ kind: "answered", answers });
    expect(events[1]).toEqual({
      type: "question_answered",
      questionId: pending.questionId,
      answers,
    });
  });

  it("an abort signal resolves the flow as aborted without a dismissed event", async () => {
    const q = await import("../src/questions.js");
    const events: Ev[] = [];
    const controller = new AbortController();
    const flow = q.askUserQuestions("proj-1", (e) => events.push(e), [QUESTION], [
      controller.signal,
    ]);
    expect(q.pendingQuestion("proj-1")).toBeDefined();
    controller.abort();
    await expect(flow).resolves.toEqual({ kind: "aborted" });
    expect(q.pendingQuestion("proj-1")).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["question"]);
  });

  it("a signal aborted up front never surfaces the question to the UI", async () => {
    const q = await import("../src/questions.js");
    const events: Ev[] = [];
    const controller = new AbortController();
    controller.abort();
    const flow = q.askUserQuestions("proj-1", (e) => events.push(e), [QUESTION], [
      controller.signal,
    ]);
    await expect(flow).resolves.toEqual({ kind: "aborted" });
    expect(events).toEqual([]);
    expect(q.pendingQuestion("proj-1")).toBeUndefined();
  });
});

describe("claude canUseTool", () => {
  const OPTIONS = { signal: new AbortController().signal, toolUseID: "tu-1" };

  it("passes every non-AskUserQuestion tool through as an unmodified allow", async () => {
    const { makeCanUseTool } = await import("../src/backends/claude.js");
    const events: Ev[] = [];
    const canUseTool = makeCanUseTool("proj-1", (e) => events.push(e), new AbortController().signal);
    const input = { file_path: "/tmp/x", content: "y" };
    await expect(canUseTool("Write", input, OPTIONS)).resolves.toEqual({
      behavior: "allow",
      updatedInput: input,
    });
    expect(events).toEqual([]);
  });

  it("answering yields allow with the answers echoed into updatedInput", async () => {
    const { makeCanUseTool } = await import("../src/backends/claude.js");
    const q = await import("../src/questions.js");
    const events: Ev[] = [];
    const canUseTool = makeCanUseTool("proj-1", (e) => events.push(e), new AbortController().signal);
    const multi = { ...QUESTION, question: "Which topics?", multiSelect: true };
    const input = { questions: [QUESTION, multi] };
    const resultPromise = canUseTool("AskUserQuestion", input, OPTIONS);

    await vi.waitFor(() => {
      if (!q.pendingQuestion("proj-1")) throw new Error("not pending yet");
    });
    // Answers key by QUESTION TEXT; multi-select answers arrive comma-joined.
    const answers = {
      "Which section should I improve?": "Introduction",
      "Which topics?": "Introduction, Conclusion",
    };
    q.answerQuestion("proj-1", q.pendingQuestion("proj-1")!.questionId, answers);
    await expect(resultPromise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { questions: input.questions, answers },
    });
    expect(events.map((e) => e.type)).toEqual(["question", "question_answered"]);
  });

  it("dismissal yields the decline deny; malformed questions deny immediately", async () => {
    const { makeCanUseTool } = await import("../src/backends/claude.js");
    const q = await import("../src/questions.js");
    const canUseTool = makeCanUseTool("proj-1", () => {}, new AbortController().signal);
    const resultPromise = canUseTool("AskUserQuestion", { questions: [QUESTION] }, OPTIONS);
    await vi.waitFor(() => {
      if (!q.pendingQuestion("proj-1")) throw new Error("not pending yet");
    });
    q.dismissQuestion("proj-1", q.pendingQuestion("proj-1")!.questionId);
    await expect(resultPromise).resolves.toEqual({
      behavior: "deny",
      message: "User declined to answer; proceed with your best judgment.",
    });

    await expect(canUseTool("AskUserQuestion", { questions: [] }, OPTIONS)).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/malformed/),
    });
  });

  it("aborting the turn denies and cleans the registry", async () => {
    const { makeCanUseTool } = await import("../src/backends/claude.js");
    const q = await import("../src/questions.js");
    const controller = new AbortController();
    const canUseTool = makeCanUseTool("proj-1", () => {}, controller.signal);
    const resultPromise = canUseTool("AskUserQuestion", { questions: [QUESTION] }, OPTIONS);
    await vi.waitFor(() => {
      if (!q.pendingQuestion("proj-1")) throw new Error("not pending yet");
    });
    controller.abort();
    await expect(resultPromise).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/interrupted/),
    });
    expect(q.pendingQuestion("proj-1")).toBeUndefined();
  });

  it("a second concurrent question fails fast with a deny", async () => {
    const { makeCanUseTool } = await import("../src/backends/claude.js");
    const q = await import("../src/questions.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const canUseTool = makeCanUseTool("proj-1", () => {}, new AbortController().signal);
      const first = canUseTool("AskUserQuestion", { questions: [QUESTION] }, OPTIONS);
      await vi.waitFor(() => {
        if (!q.pendingQuestion("proj-1")) throw new Error("not pending yet");
      });
      await expect(
        canUseTool("AskUserQuestion", { questions: [QUESTION] }, OPTIONS),
      ).resolves.toMatchObject({
        behavior: "deny",
        message: expect.stringMatching(/already pending/),
      });
      // The first ask is still answerable.
      q.answerQuestion("proj-1", q.pendingQuestion("proj-1")!.questionId, { a: "b" });
      await expect(first).resolves.toMatchObject({ behavior: "allow" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("chat transcript round-trip", () => {
  it("question events persist and restore intact", async () => {
    const config = await import("../src/config.js");
    const chats = await import("../src/chats.js");
    const project = config.addProject({ name: "Q Round Trip", gitUrl: "local", kind: "local" });
    const chat = chats.createChat(project.id);
    const events: Ev[] = [
      { type: "question", projectId: project.id, questionId: "q-11112222", questions: [QUESTION] },
      {
        type: "question_answered",
        questionId: "q-11112222",
        answers: { [QUESTION.question]: "Introduction" },
      },
      { type: "question", projectId: project.id, questionId: "q-33334444", questions: [QUESTION] },
      { type: "question_dismissed", questionId: "q-33334444" },
    ];
    for (const ev of events) chats.appendEvent(project.id, chat.id, ev as { type: string });
    expect(chats.readTranscript(project.id, chat.id)).toEqual(events);
  });
});
