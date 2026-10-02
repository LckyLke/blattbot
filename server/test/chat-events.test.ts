/**
 * The chat's one event → item mapping (web/src/chat-events.ts). The live
 * websocket handler and the transcript replay both fold events through
 * applyChatEvent; they used to be two hand-written copies that disagreed
 * (question_answered without answers, tool_use field checks). The module is
 * DOM-free, so it runs under node like the other web-module tests.
 */
import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  replayChatEvents,
  type ChatItem,
} from "../../web/src/chat-events.js";
import type { ChatTranscriptEvent } from "../../web/src/api.js";

/** Fold events the way the live handler does: one fresh uid per event. */
function live(events: ChatTranscriptEvent[], projectKind?: "git" | "overleaf" | "local"): ChatItem[] {
  return events.reduce<ChatItem[]>(
    (items, ev, i) => applyChatEvent(items, ev, { uid: `live:${i}`, projectKind }),
    [],
  );
}

const withoutUid = (items: ChatItem[]) => items.map(({ uid: _uid, ...rest }) => rest);

/** A persisted turn: what the server writes to the chat's .jsonl. */
const TURN: ChatTranscriptEvent[] = [
  { type: "user_message", text: "Fix the intro", scope: ["main.tex", 3], attachments: [{ id: "img1", mime: "image/png" }, { nope: true }] },
  { type: "tool_use", id: "t1", name: "Edit", detail: "main.tex", input: "{}" },
  { type: "tool_result", id: "t1", output: "ok", fileDiff: "diff --git a/main.tex b/main.tex\n", resultHead: "1 edit" },
  { type: "notice", tone: "warn", text: "Citations: 1 claim to check", citationGroup: "turn-1" },
  { type: "notice", tone: "warn", text: "Citations: 2 claims to check", citationGroup: "turn-1" },
  { type: "text_final", text: "Done." },
  { type: "turn_end", costUsd: 0.02, durationMs: 1500, inputTokens: "12" },
];

describe("applyChatEvent", () => {
  it("grows one streaming bubble and settles it in place, keeping its identity", () => {
    let items = applyChatEvent([], { type: "text_delta", text: "Hel" }, { uid: "a" });
    items = applyChatEvent(items, { type: "text_delta", text: "lo" }, { uid: "b" });
    expect(items).toEqual([{ uid: "a", kind: "agent", text: "Hello", streaming: true }]);
    items = applyChatEvent(items, { type: "text_final", text: "Hello!" }, { uid: "c" });
    expect(items).toEqual([{ uid: "a", kind: "agent", text: "Hello!", streaming: false }]);
  });

  it("resolves a tool chip by id and keeps only meaningful result fields", () => {
    const items = live([
      { type: "tool_use", id: "t1", name: "Grep", detail: "foo", input: { not: "a string" } },
      { type: "tool_result", id: "t1", isError: true, output: 42, fileDiff: "  ", resultHead: "" },
    ]);
    expect(items).toEqual([
      { uid: "live:0", kind: "tool", id: "t1", name: "Grep", detail: "foo", input: undefined, status: "error", output: undefined },
    ]);
  });

  it("returns the same array for events that do not touch the chat", () => {
    const items = live([{ type: "tool_use", id: "t1", name: "Read" }]);
    for (const ev of [
      { type: "diff", diff: "" },
      { type: "compile_start" },
      { type: "tool_result", id: "unknown" },
      { type: "tool_result" },
      { type: "question_answered", questionId: "missing" },
    ]) {
      expect(applyChatEvent(items, ev, { uid: "x" })).toBe(items);
    }
  });

  it("settles question cards: answers kept when the echo carries none, dismissal, no duplicate cards", () => {
    let items = live([{ type: "question", questionId: "q1", questions: [{ question: "A or B?", header: "Pick", options: [], multiSelect: false }] }]);
    expect(items[0]).toMatchObject({ uid: "q:q1", status: "pending" });
    // A re-broadcast (e.g. after a reconnect backfill) must not add a second card.
    expect(applyChatEvent(items, { type: "question", questionId: "q1", questions: [] }, { uid: "y" })).toBe(items);

    const answered = applyChatEvent(items, { type: "question_answered", questionId: "q1", answers: { "A or B?": "A" } }, { uid: "z" });
    expect(answered[0]).toMatchObject({ status: "answered", answers: { "A or B?": "A" } });
    const echoed = applyChatEvent(answered, { type: "question_answered", questionId: "q1" }, { uid: "z" });
    expect(echoed[0]).toMatchObject({ status: "answered", answers: { "A or B?": "A" } });
    expect(applyChatEvent(items, { type: "question_dismissed", questionId: "q1" }, { uid: "z" })[0]).toMatchObject({ status: "dismissed" });
  });

  it("closes the turn: streaming bubbles settle, pending questions collapse, numbers are checked", () => {
    const items = live([
      { type: "text_delta", text: "partial" },
      { type: "question", questionId: "q1", questions: [] },
      { type: "turn_end", costUsd: 0.5, durationMs: "slow", contextTokens: 900 },
    ]);
    expect(items.map((it) => [it.kind, "streaming" in it ? it.streaming : "status" in it ? it.status : undefined])).toEqual([
      ["agent", false],
      ["question", "dismissed"],
      ["turn_end", undefined],
    ]);
    expect(items[2]).toMatchObject({ costUsd: 0.5, durationMs: undefined, contextTokens: 900 });
    expect(live([{ type: "turn_end", interrupted: true }])).toEqual([
      { uid: "live:0", kind: "notice", tone: "warn", text: "Turn interrupted." },
    ]);
  });

  it("words errors and sync warnings exactly as the server persists them", () => {
    expect(withoutUid(live([{ type: "error", message: "boom" }, { type: "error" }, { type: "sync_warning", message: "drift" }]))).toEqual([
      { kind: "notice", tone: "error", text: "boom" },
      { kind: "notice", tone: "error", text: "agent error" },
      { kind: "notice", tone: "warn", text: "Sync: drift" },
    ]);
  });

  it("reports approvals per project kind, with warnings and absorbed remote edits", () => {
    const ev = { type: "approved", pushed: true, warnings: ["comments may be lost"], absorbedRemote: ["a.tex"] };
    expect(withoutUid(live([ev], "overleaf"))).toEqual([
      { kind: "notice", tone: "ok", text: "Changes pushed to Overleaf." },
      { kind: "notice", tone: "warn", text: "comments may be lost" },
      { kind: "notice", tone: "info", text: "Also picked up Overleaf changes to: a.tex" },
    ]);
    expect(live([{ type: "approved", pushed: true }], "local")[0]).toMatchObject({ text: "Committed locally." });
    expect(live([{ type: "approved" }], "git")[0]).toMatchObject({ text: "Nothing to push." });
    // Several items from one event still get distinct identities.
    expect(new Set(live([ev], "overleaf").map((it) => it.uid)).size).toBe(3);
  });
});

describe("replayChatEvents", () => {
  it("renders a persisted turn exactly as the live view built it", () => {
    expect(withoutUid(replayChatEvents(TURN, "chat1"))).toEqual(withoutUid(live(TURN)));
    expect(withoutUid(replayChatEvents(TURN, "chat1"))).toEqual([
      { kind: "user", text: "Fix the intro", scope: ["main.tex"], images: [{ id: "img1", mime: "image/png" }] },
      {
        kind: "tool",
        id: "t1",
        name: "Edit",
        detail: "main.tex",
        input: "{}",
        status: "done",
        output: "ok",
        fileDiff: "diff --git a/main.tex b/main.tex\n",
        resultHead: "1 edit",
      },
      // The citation summary of the same turn is replaced, not repeated.
      { kind: "notice", tone: "warn", text: "Citations: 2 claims to check", citationGroup: "turn-1", details: undefined },
      { kind: "agent", text: "Done.", streaming: false },
      {
        kind: "turn_end",
        costUsd: 0.02,
        durationMs: 1500,
        contextTokens: undefined,
        contextWindow: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
      },
    ]);
  });

  it("derives stable identities, so a second restore keeps every bubble", () => {
    const first = replayChatEvents(TURN, "chat1");
    const again = replayChatEvents([...TURN, { type: "user_message", text: "next" }], "chat1");
    expect(again.slice(0, first.length).map((it) => it.uid)).toEqual(first.map((it) => it.uid));
    expect(new Set(again.map((it) => it.uid)).size).toBe(again.length);
    // Another chat's transcript never reuses this chat's identities.
    expect(replayChatEvents(TURN, "chat2")[0].uid).not.toBe(first[0].uid);
  });

  it("keeps only the turn state's pending question actionable; another open one is stale", () => {
    const events: ChatTranscriptEvent[] = [
      { type: "question", questionId: "old", questions: [] },
      { type: "question", questionId: "now", questions: [] },
    ];
    expect(replayChatEvents(events, "c", "now").map((it) => [it.uid, "status" in it && it.status])).toEqual([
      ["q:old", "stale"],
      ["q:now", "pending"],
    ]);
    // The same card from the live event and from the restore shares its identity.
    expect(live([events[1]])[0].uid).toBe("q:now");
  });

  it("skips malformed lines", () => {
    expect(replayChatEvents([null as unknown as ChatTranscriptEvent, { type: "mystery" }, { type: "text_final", text: "ok" }], "c")).toEqual([
      { uid: "c:2", kind: "agent", text: "ok", streaming: false },
    ]);
  });
});
