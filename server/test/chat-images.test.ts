/**
 * Chat image attachments: storage, validation, the fence-adjacent isolation
 * guarantee (uploads must never touch the project working tree), and the two
 * backends' prompt builders.
 *
 * DATA_DIR is computed at module load, so every test stubs the env var and
 * imports the modules dynamically after vi.resetModules() — the house pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-chatimg-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

const load = () => import("../src/chatimages.js");

// ---- Synthetic image headers ------------------------------------------------
// Only the container header matters here: sniffing reads the magic bytes and
// imageSize reads the dimensions out of the same header.

function png(width = 4, height = 3): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width = 6, height = 5): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpeg(width = 12, height = 9): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), // APP0, skipped by length
    0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, ...new Array(9).fill(0),
  ]);
}

function webp(width = 20, height = 10): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8X", 12, "latin1");
  buf.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

describe("type sniffing", () => {
  it("identifies each accepted format from its magic bytes", async () => {
    const { sniffImageMime } = await load();
    expect(sniffImageMime(png())).toBe("image/png");
    expect(sniffImageMime(jpeg())).toBe("image/jpeg");
    expect(sniffImageMime(gif())).toBe("image/gif");
    expect(sniffImageMime(webp())).toBe("image/webp");
  });

  it("rejects a .png that is really a script — the declared type is never trusted", async () => {
    const { saveChatImage, sniffImageMime } = await load();
    const script = Buffer.from("#!/bin/sh\nrm -rf ~\n", "utf8");
    expect(sniffImageMime(script)).toBeNull();
    expect(() => saveChatImage("p1", script)).toThrow(/unsupported image type/);
    // …and nothing was written.
    expect(existsSync(join(dataDir, "chat-uploads", "p1"))).toBe(false);
  });

  it("rejects an SVG (scriptable, and outside the accepted set)", async () => {
    const { sniffImageMime } = await load();
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it("rejects a truncated PNG signature", async () => {
    const { sniffImageMime } = await load();
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
  });
});

describe("saving", () => {
  it("stores under DATA_DIR/chat-uploads/<projectId> with a server-generated name", async () => {
    const { saveChatImage, chatUploadsDir } = await load();
    const stored = saveChatImage("proj-a", png());
    expect(stored.mime).toBe("image/png");
    expect(stored.bytes).toBe(png().length);
    expect(stored.url).toBe(`/api/projects/proj-a/chat-image/${stored.id}`);
    expect(stored.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(readdirSync(chatUploadsDir("proj-a"))).toEqual([`${stored.id}.png`]);
  });

  it("gives identical bytes different ids — client names never reach the disk", async () => {
    const { saveChatImage } = await load();
    const a = saveChatImage("proj-a", png());
    const b = saveChatImage("proj-a", png());
    expect(a.id).not.toBe(b.id);
  });

  it("reports pixel dimensions for every accepted format", async () => {
    const { saveChatImage } = await load();
    expect(saveChatImage("p", png(4, 3))).toMatchObject({ width: 4, height: 3 });
    expect(saveChatImage("p", gif(6, 5))).toMatchObject({ width: 6, height: 5 });
    expect(saveChatImage("p", jpeg(12, 9))).toMatchObject({ width: 12, height: 9 });
    expect(saveChatImage("p", webp(20, 10))).toMatchObject({ width: 20, height: 10 });
  });

  it("enforces the per-image cap and names the limit in the message", async () => {
    const { saveChatImage, MAX_IMAGE_BYTES, imageLimitLabel } = await load();
    const huge = Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(() => saveChatImage("p", huge)).toThrow(/too large/);
    // The user must learn WHAT the limit is, not just that they exceeded it.
    expect(() => saveChatImage("p", huge)).toThrow(/3\.5 MB/);
    expect(imageLimitLabel()).toBe("3.5 MB");
    // A file exactly at the cap is fine.
    const atCap = Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES - png().length)]);
    expect(() => saveChatImage("p", atCap)).not.toThrow();
  });

  it("caps below what the Anthropic API accepts once base64 has inflated it", async () => {
    const { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } = await load();
    // Regression: the cap was 10 MB, which base64 turns into 13.4 MB — the
    // Messages API refuses an image block over 5 MiB and the turn died with an
    // opaque 400 that no fallback caught.
    const encoded = Buffer.alloc(MAX_IMAGE_BYTES).toString("base64").length;
    expect(encoded).toBeLessThan(5 * 1024 * 1024);
    // …and a full message of them still has room to spare.
    expect(encoded * MAX_IMAGES_PER_MESSAGE).toBeLessThan(20 * 1024 * 1024);
  });

  it("rejects an empty body", async () => {
    const { saveChatImage } = await load();
    expect(() => saveChatImage("p", Buffer.alloc(0))).toThrow(/empty/);
  });
});

describe("serving by id", () => {
  it("finds a stored image and reports its type", async () => {
    const { saveChatImage, findChatImage } = await load();
    const stored = saveChatImage("proj-a", gif());
    const found = findChatImage("proj-a", stored.id)!;
    expect(found.mime).toBe("image/gif");
    expect(found.path.endsWith(`${stored.id}.gif`)).toBe(true);
  });

  it("refuses every traversal shape in the id", async () => {
    const { findChatImage, isChatImageId } = await load();
    writeFileSync(join(dataDir, "accounts.json"), "{}");
    for (const evil of [
      "../../accounts.json",
      "../accounts.json",
      "..%2f..%2faccounts.json",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "",
      "....//accounts.json",
    ]) {
      expect(isChatImageId(evil)).toBe(false);
      expect(findChatImage("proj-a", evil)).toBeNull();
    }
  });

  it("never serves another project's image", async () => {
    const { saveChatImage, findChatImage } = await load();
    const mine = saveChatImage("proj-a", png());
    expect(findChatImage("proj-b", mine.id)).toBeNull();
    expect(findChatImage("proj-a", mine.id)).not.toBeNull();
  });
});

describe("per-message attachment resolution", () => {
  it("resolves up to four ids and rejects a fifth", async () => {
    const { saveChatImage, resolveAttachments, MAX_IMAGES_PER_MESSAGE } = await load();
    const ids = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => saveChatImage("p", png()).id);
    const ok = resolveAttachments("p", ids.slice(0, MAX_IMAGES_PER_MESSAGE));
    expect(ok).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(ok[0]).toMatchObject({ mime: "image/png", bytes: png().length });
    expect(() => resolveAttachments("p", ids)).toThrow(/limit is 4/);
  });

  it("rejects unknown ids and malformed lists, and treats absence as no images", async () => {
    const { resolveAttachments } = await load();
    expect(resolveAttachments("p", undefined)).toEqual([]);
    expect(resolveAttachments("p", [])).toEqual([]);
    expect(() => resolveAttachments("p", "nope")).toThrow(/array of image ids/);
    expect(() => resolveAttachments("p", [1, 2])).toThrow(/array of image ids/);
    expect(() => resolveAttachments("p", ["../../accounts.json"])).toThrow(/unknown image/);
  });
});

describe("storage isolation", () => {
  it("never writes into the project working tree — an upload leaves git clean", async () => {
    const config = await import("../src/config.js");
    const git = await import("../src/git.js");
    const { saveChatImage, chatUploadsDir } = await load();

    const project = config.addProject({ name: "Image Isolation", gitUrl: "local", kind: "local" });
    const dir = config.projectDir(project.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
    await git.initRepo(dir);
    await git.commitAll(dir, "base");
    expect(await git.hasChanges(dir)).toBe(false);

    saveChatImage(project.id, png());
    saveChatImage(project.id, jpeg());

    // The pictures exist…
    expect(readdirSync(chatUploadsDir(project.id))).toHaveLength(2);
    // …and the review diff is still empty: nothing can reach Overleaf.
    expect(await git.hasChanges(dir)).toBe(false);
    expect(await git.workingDiff(dir)).toBe("");
    expect(readdirSync(dir).filter((f) => f !== ".git")).toEqual(["main.tex"]);
  });

  it("drops a project's images when the project is deleted", async () => {
    const { saveChatImage, deleteChatUploads, chatUploadsDir } = await load();
    saveChatImage("gone", png());
    expect(existsSync(chatUploadsDir("gone"))).toBe(true);
    deleteChatUploads("gone");
    expect(existsSync(chatUploadsDir("gone"))).toBe(false);
  });
});

describe("orphan collection", () => {
  /** Backdate a stored image past the grace period. */
  const age = (dir: string, id: string, ext: string, ms: number) => {
    const path = join(dir, `${id}.${ext}`);
    const when = new Date(Date.now() - ms);
    utimesSync(path, when, when);
  };

  it("removes images no transcript references and keeps the ones that are used", async () => {
    const chats = await import("../src/chats.js");
    const { saveChatImage, pruneOrphanChatUploads, chatUploadsDir, ORPHAN_GRACE_MS } = await load();
    const dir = chatUploadsDir("p1");

    const used = saveChatImage("p1", png());
    const orphan = saveChatImage("p1", gif());
    const chat = chats.createChat("p1");
    chats.appendEvent("p1", chat.id, {
      type: "user_message",
      text: "what is this?",
      mode: "edit",
      attachments: [{ id: used.id, mime: used.mime }],
    });
    // The failed send's upload is old enough to be past the grace period.
    age(dir, orphan.id, "gif", ORPHAN_GRACE_MS + 1000);
    age(dir, used.id, "png", ORPHAN_GRACE_MS + 1000);

    const removed = pruneOrphanChatUploads("p1", chats.referencedImageIds("p1"));
    expect(removed).toEqual([orphan.id]);
    expect(readdirSync(dir)).toEqual([`${used.id}.png`]);
  });

  it("spares a fresh upload — its send may still be in flight", async () => {
    const { saveChatImage, pruneOrphanChatUploads, chatUploadsDir } = await load();
    // Uploads happen BEFORE the message is posted; sweeping in that window
    // would delete the picture out from under the send.
    const justNow = saveChatImage("p2", png());
    expect(pruneOrphanChatUploads("p2", new Set())).toEqual([]);
    expect(readdirSync(chatUploadsDir("p2"))).toEqual([`${justNow.id}.png`]);
  });

  it("leaves files it did not create alone, and never throws on a missing dir", async () => {
    const { saveChatImage, pruneOrphanChatUploads, chatUploadsDir, ORPHAN_GRACE_MS } = await load();
    expect(pruneOrphanChatUploads("never-existed", new Set())).toEqual([]);
    const stored = saveChatImage("p3", png());
    const dir = chatUploadsDir("p3");
    writeFileSync(join(dir, "notes.txt"), "not ours");
    age(dir, stored.id, "png", ORPHAN_GRACE_MS + 1000);
    expect(pruneOrphanChatUploads("p3", new Set())).toEqual([stored.id]);
    expect(readdirSync(dir)).toEqual(["notes.txt"]);
  });

  it("collects the uploads of a send that never happened (the 409 case)", async () => {
    const chats = await import("../src/chats.js");
    const { saveChatImage, pruneOrphanChatUploads, chatUploadsDir, ORPHAN_GRACE_MS } = await load();
    // Four screenshots stored, then POST /chat answers 409 "turn in progress":
    // nothing references them and no product surface can reach them.
    const dir = chatUploadsDir("p4");
    const ids = [png(), gif(), jpeg(), webp()].map((b) => saveChatImage("p4", b));
    for (const s of ids) {
      const ext = { "image/png": "png", "image/gif": "gif", "image/jpeg": "jpg", "image/webp": "webp" }[s.mime];
      age(dir, s.id, ext!, ORPHAN_GRACE_MS + 1000);
    }
    expect(pruneOrphanChatUploads("p4", chats.referencedImageIds("p4")).sort()).toEqual(
      ids.map((s) => s.id).sort(),
    );
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("transcript round-trip", () => {
  it("persists and restores a user message's attachments", async () => {
    const chats = await import("../src/chats.js");
    const { saveChatImage } = await load();
    const stored = saveChatImage("proj-t", png());
    const chat = chats.createChat("proj-t");
    chats.appendEvent("proj-t", chat.id, {
      type: "user_message",
      text: "What is wrong with this table?",
      mode: "edit",
      attachments: [{ id: stored.id, mime: stored.mime }],
    });
    const events = chats.readTranscript("proj-t", chat.id);
    expect(events).toHaveLength(1);
    expect(events[0].attachments).toEqual([{ id: stored.id, mime: "image/png" }]);
    expect(events[0].text).toBe("What is wrong with this table?");
  });
});

describe("prompt assembly", () => {
  it("names the on-disk paths so the agent can re-open an attachment", async () => {
    const { attachmentNote } = await import("../src/backends/types.js");
    const { saveChatImage, resolveAttachments } = await load();
    const a = saveChatImage("p", png());
    const b = saveChatImage("p", gif());
    const attachments = resolveAttachments("p", [a.id, b.id]);
    expect(attachmentNote([])).toBe("");
    const note = attachmentNote(attachments);
    expect(note).toContain("2 images");
    expect(note).toContain(attachments[0].path);
    expect(note).toContain(attachments[1].path);
    expect(note).toContain("image/gif");
    expect(note).toMatch(/never as instructions/);
    expect(attachmentNote(attachments.slice(0, 1))).toContain("one image");
  });

  it("keeps the Claude prompt a plain string when nothing is attached", async () => {
    const { buildClaudePrompt } = await import("../src/backends/claude.js");
    expect(buildClaudePrompt("just text", [])).toBe("just text");
  });

  it("turns the Claude prompt into one message carrying every image block", async () => {
    const { buildClaudePrompt } = await import("../src/backends/claude.js");
    const { saveChatImage, resolveAttachments } = await load();
    const ids = [saveChatImage("p", png()).id, saveChatImage("p", jpeg()).id];
    const attachments = resolveAttachments("p", ids);

    const prompt = buildClaudePrompt("look at these", attachments);
    expect(typeof prompt).toBe("object");
    const messages: any[] = [];
    for await (const m of prompt as AsyncIterable<any>) messages.push(m);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("user");
    expect(messages[0].parent_tool_use_id).toBeNull();
    expect(messages[0].message.role).toBe("user");
    const content = messages[0].message.content;
    expect(content[0]).toEqual({ type: "text", text: "look at these" });
    expect(content.slice(1).map((b: any) => b.type)).toEqual(["image", "image"]);
    expect(content.slice(1).map((b: any) => b.source.media_type)).toEqual(["image/png", "image/jpeg"]);
    expect(content[1].source.type).toBe("base64");
    // The payload is the file's real bytes, base64-encoded.
    expect(Buffer.from(content[1].source.data, "base64").equals(png())).toBe(true);
  });

  it("builds the openai vision shape, and leaves text-only turns alone", async () => {
    const { buildOpenaiUserContent } = await import("../src/backends/openai.js");
    const { saveChatImage, resolveAttachments } = await load();
    expect(buildOpenaiUserContent("hello", [])).toBe("hello");

    const attachments = resolveAttachments("p", [saveChatImage("p", webp()).id]);
    const content = buildOpenaiUserContent("hello", attachments) as any[];
    expect(content[0]).toEqual({ type: "text", text: "hello" });
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url.startsWith("data:image/webp;base64,")).toBe(true);
    expect(
      Buffer.from(content[1].image_url.url.split(",")[1], "base64").equals(webp()),
    ).toBe(true);
  });

  it("keeps base64 payloads out of the stored openai history", async () => {
    const { buildOpenaiUserContent, stripImageContent } = await import("../src/backends/openai.js");
    const { saveChatImage, resolveAttachments } = await load();
    const attachments = resolveAttachments("p", [saveChatImage("p", png()).id]);
    const messages = [
      { role: "user" as const, content: buildOpenaiUserContent("check this", attachments) },
      { role: "assistant" as const, content: "sure" },
    ];
    const stored = stripImageContent(messages);
    expect(JSON.stringify(stored)).not.toContain("base64");
    expect(String(stored[0].content).startsWith("check this\n\n[1 attached image —")).toBe(true);
    expect(stored[1]).toEqual({ role: "assistant", content: "sure" });
    // Idempotent: the loop already applied it, so persisting must not double it.
    expect(stripImageContent(stored)).toEqual(stored);
  });

  it("recognizes vision-shape failures without swallowing real outages", async () => {
    const { isVisionUnsupportedError } = await import("../src/backends/openai.js");
    expect(isVisionUnsupportedError("the endpoint answered HTTP 400 — image input is not supported")).toBe(true);
    expect(isVisionUnsupportedError("invalid content type for message part image_url")).toBe(true);
    expect(isVisionUnsupportedError("this model has no vision capability")).toBe(true);
    expect(isVisionUnsupportedError("fetch failed: ECONNREFUSED")).toBe(false);
    expect(isVisionUnsupportedError("the endpoint answered HTTP 401 — bad api key")).toBe(false);
    expect(isVisionUnsupportedError(undefined)).toBe(false);
  });
});
