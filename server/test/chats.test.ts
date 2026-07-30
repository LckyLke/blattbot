import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-chats-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  const config = await import("../src/config.js");
  const chats = await import("../src/chats.js");
  return { config, chats };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("chat store", () => {
  it("creates, lists, and reads back chats", async () => {
    const { chats } = await load();
    expect(chats.listChats("p1")).toEqual([]);
    const a = chats.createChat("p1");
    expect(a.title).toBe("New chat");
    expect(a.id).toMatch(/^chat-[0-9a-f]{8}$/);
    await tick();
    const b = chats.createChat("p1");
    const listed = chats.listChats("p1");
    expect(listed.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    // Newest-updated first.
    expect(listed[0].id).toBe(b.id);
    expect(chats.getChat("p1", a.id)?.id).toBe(a.id);
    expect(chats.getChat("p1", "chat-nope")).toBeUndefined();
    // Per-project isolation.
    expect(chats.listChats("p2")).toEqual([]);
  });

  it("appends events, derives the title from the first user message, and reads the transcript", async () => {
    const { chats } = await load();
    const chat = chats.createChat("p1");
    const before = chats.getChat("p1", chat.id)!.updatedAt;
    await tick();
    chats.appendEvent("p1", chat.id, {
      type: "user_message",
      text: "  Rewrite the   introduction\nto be sharper and much more concise please  ",
      mode: "edit",
    });
    chats.appendEvent("p1", chat.id, { type: "text_final", text: "Done." });
    chats.appendEvent("p1", chat.id, { type: "turn_end", isError: false, costUsd: 0.1 });

    const meta = chats.getChat("p1", chat.id)!;
    // Whitespace collapsed, capped at ~40 chars with an ellipsis.
    expect(meta.title).toBe("Rewrite the introduction to be sharper…");
    expect(meta.title.length).toBeLessThanOrEqual(chats.TITLE_MAX);
    expect(meta.updatedAt > before).toBe(true);

    const events = chats.readTranscript("p1", chat.id);
    expect(events.map((e) => e.type)).toEqual(["user_message", "text_final", "turn_end"]);
    expect(events[1].text).toBe("Done.");

    // A later user message does not retitle.
    chats.appendEvent("p1", chat.id, { type: "user_message", text: "Second message", mode: "edit" });
    expect(chats.getChat("p1", chat.id)!.title).toBe("Rewrite the introduction to be sharper…");
  });

  it("keeps short titles verbatim and refuses events on unknown chats", async () => {
    const { chats } = await load();
    const chat = chats.createChat("p1");
    chats.appendEvent("p1", chat.id, { type: "user_message", text: "Fix a typo", mode: "edit" });
    expect(chats.getChat("p1", chat.id)!.title).toBe("Fix a typo");
    expect(() => chats.appendEvent("p1", "chat-nope", { type: "text_final", text: "x" })).toThrow(
      /unknown chat/,
    );
  });

  it("skips malformed transcript lines", async () => {
    const { chats } = await load();
    const chat = chats.createChat("p1");
    chats.appendEvent("p1", chat.id, { type: "text_final", text: "ok" });
    const path = chats.transcriptPath("p1", chat.id);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(path, "{not json\n");
    appendFileSync(path, JSON.stringify({ type: "turn_end", isError: false }) + "\n");
    expect(chats.readTranscript("p1", chat.id).map((e) => e.type)).toEqual([
      "text_final",
      "turn_end",
    ]);
  });

  it("deletes chats along with their transcripts", async () => {
    const { chats } = await load();
    const chat = chats.createChat("p1");
    chats.appendEvent("p1", chat.id, { type: "text_final", text: "bye" });
    const path = chats.transcriptPath("p1", chat.id);
    expect(existsSync(path)).toBe(true);
    expect(chats.deleteChat("p1", chat.id)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(chats.listChats("p1")).toEqual([]);
    expect(chats.deleteChat("p1", chat.id)).toBe(false);
  });

  it("resolves the active chat: valid id wins, else newest, else a fresh chat", async () => {
    const { config, chats } = await load();
    const p = config.addProject({ name: "T", gitUrl: "", kind: "local" });

    // No chats at all → one is created and activated.
    const first = chats.ensureActiveChat(p.id);
    expect(first.title).toBe("New chat");
    expect(config.getProject(p.id)!.activeChatId).toBe(first.id);
    // Stable across calls.
    expect(chats.ensureActiveChat(p.id).id).toBe(first.id);

    // A second chat, activated, then deleted → falls back to the newest remaining.
    await tick();
    const second = chats.createChat(p.id);
    expect(chats.setActiveChat(p.id, second.id)?.id).toBe(second.id);
    expect(config.getProject(p.id)!.activeChatId).toBe(second.id);
    await tick();
    chats.appendEvent(p.id, first.id, { type: "text_final", text: "bump" }); // first is now newest
    expect(chats.deleteChat(p.id, second.id)).toBe(true);
    expect(config.getProject(p.id)!.activeChatId).toBeUndefined();
    expect(chats.ensureActiveChat(p.id).id).toBe(first.id);
    expect(config.getProject(p.id)!.activeChatId).toBe(first.id);

    // Activating an unknown chat is refused.
    expect(chats.setActiveChat(p.id, "chat-nope")).toBeUndefined();
  });

  it("migrates a legacy per-project session into an 'Earlier conversation' chat", async () => {
    const { config, chats } = await load();
    const p = config.addProject({ name: "Legacy", gitUrl: "", kind: "local" });
    config.updateProject(p.id, { sessionId: "sess-legacy-1" });

    const listed = chats.listChats(p.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("Earlier conversation");
    expect(listed[0].sessionId).toBe("sess-legacy-1");
    expect(config.getProject(p.id)!.activeChatId).toBe(listed[0].id);

    // The transcript starts with the synthetic notice about the lost history.
    const events = chats.readTranscript(p.id, listed[0].id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "notice", tone: "info" });
    expect(String(events[0].text)).toContain("still remembers");

    // Migration is one-shot: deleting every chat does not resurrect it,
    // even though project.sessionId is still set for backward compat.
    expect(chats.deleteChat(p.id, listed[0].id)).toBe(true);
    expect(chats.listChats(p.id)).toEqual([]);
    const fresh = chats.ensureActiveChat(p.id);
    expect(fresh.title).toBe("New chat");
    expect(fresh.sessionId).toBeUndefined();
  });

  it("does not migrate projects without a legacy session", async () => {
    const { config, chats } = await load();
    const p = config.addProject({ name: "Fresh", gitUrl: "", kind: "local" });
    expect(chats.listChats(p.id)).toEqual([]);
    const active = chats.ensureActiveChat(p.id);
    expect(active.title).toBe("New chat");
  });

  it("updates sessionId per chat and strips it from the public view", async () => {
    const { chats } = await load();
    const chat = chats.createChat("p1");
    const updated = chats.updateChat("p1", chat.id, { sessionId: "sess-42" })!;
    expect(updated.sessionId).toBe("sess-42");
    // Persisted to disk.
    const raw = JSON.parse(readFileSync(join(dir, "chats", "p1", "chats.json"), "utf8"));
    expect(raw[0].sessionId).toBe("sess-42");
    expect(chats.publicChat(updated)).not.toHaveProperty("sessionId");
    expect(chats.publicChat(updated)).toMatchObject({ id: chat.id, title: "New chat" });
    expect(chats.updateChat("p1", "chat-nope", { sessionId: "x" })).toBeUndefined();
  });
});
