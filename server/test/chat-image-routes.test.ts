/**
 * HTTP coverage of the chat-attachment routes: the upload cap and its message,
 * an image-only message being a valid send, and the orphan sweep that runs
 * when a project's chat list is fetched. Boots the real server in-process
 * against an isolated data dir; the agent backend points at a closed port, so
 * a started turn fails immediately and no real API is ever contacted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_PORT = 4663;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

/** A minimal but real PNG header — the route sniffs magic bytes, not names. */
function png(width = 4, height = 3): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("chat image routes", () => {
  let dataDir: string;
  let app: import("fastify").FastifyInstance;
  let token: string;
  let projectId: string;
  let images: typeof import("../src/chatimages.js");
  let chats: typeof import("../src/chats.js");

  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${SERVER_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  const upload = (bytes: Buffer) =>
    fetch(`${SERVER_BASE}/api/projects/${projectId}/chat-image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    });

  /** Wait for the background turn a successful POST /chat kicks off. */
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const detail = (await (await call(`/api/projects/${projectId}`)).json()) as { turnActive?: boolean };
      if (!detail.turnActive) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-chatimg-routes-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.stubEnv("BLATTBOT_PORT", String(SERVER_PORT));
    vi.resetModules();
    ({ app } = await import("../src/index.js"));
    // Same module instances the routes use — no reset in between.
    images = await import("../src/chatimages.js");
    chats = await import("../src/chats.js");
    const settings = await import("../src/settings.js");
    // A dead endpoint: any turn this test starts fails at once, locally.
    settings.saveSettings({ backend: "openai", openaiBaseUrl: "http://127.0.0.1:1/v1", openaiModel: "none" });

    const boot = await fetch(`${SERVER_BASE}/api/bootstrap`);
    token = ((await boot.json()) as { token: string }).token;
    const created = await call("/api/projects", { method: "POST", body: { local: true, name: "Chat Images" } });
    expect(created.status).toBe(200);
    projectId = ((await created.json()) as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("stores an accepted image and serves it back with its own media type", async () => {
    const res = await upload(png());
    expect(res.status).toBe(200);
    const stored = (await res.json()) as { id: string; mime: string; width: number; height: number };
    expect(stored.mime).toBe("image/png");
    expect(stored).toMatchObject({ width: 4, height: 3 });
    const served = await call(`/api/projects/${projectId}/chat-image/${stored.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/png");
  });

  it("refuses an oversized image with a 400 that states the limit", async () => {
    // Regression: the cap was 10 MB, ~3x what the Anthropic API accepts once
    // base64 has inflated the payload — the upload succeeded and the TURN died.
    const tooBig = Buffer.concat([png(), Buffer.alloc(images.MAX_IMAGE_BYTES)]);
    const res = await upload(tooBig);
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/too large/);
    expect(error).toContain("3.5 MB");
  });

  it("refuses a renamed non-image outright", async () => {
    const res = await upload(Buffer.from("#!/bin/sh\nrm -rf ~\n"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unsupported image type/);
  });

  it("accepts a message that is images only — no text required", async () => {
    const stored = (await (await upload(png())).json()) as { id: string };
    // "Here's a screenshot" with no words is the natural way to use a
    // paste-an-image composer; the route used to answer 400.
    const res = await call(`/api/projects/${projectId}/chat`, {
      method: "POST",
      body: { message: "", mode: "edit", images: [stored.id] },
    });
    expect(res.status).toBe(200);
    await settle();
    // The transcript records the attachment, and the chat is titled after it
    // rather than being left as "New chat".
    const events = chats
      .listChats(projectId)
      .flatMap((c) => chats.readTranscript(projectId, c.id))
      .filter((e) => e.type === "user_message");
    expect(events.some((e) => JSON.stringify(e.attachments ?? []).includes(stored.id))).toBe(true);
    expect(chats.listChats(projectId).some((c) => c.title === "Attached image")).toBe(true);
  });

  it("still rejects a message with neither text nor images", async () => {
    const res = await call(`/api/projects/${projectId}/chat`, {
      method: "POST",
      body: { message: "   ", mode: "edit" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/message is required/);
  });

  it("collects uploads whose send never happened when the chat list is fetched", async () => {
    const dir = images.chatUploadsDir(projectId);
    const referenced = chats.referencedImageIds(projectId);
    expect(referenced.size).toBeGreaterThan(0);

    // An upload that no message ever carried — the 409/closed-tab case.
    const orphan = (await (await upload(png())).json()) as { id: string };
    const old = new Date(Date.now() - images.ORPHAN_GRACE_MS - 60_000);
    utimesSync(join(dir, `${orphan.id}.png`), old, old);
    for (const id of referenced) utimesSync(join(dir, `${id}.png`), old, old);

    // Project open (any chat-list fetch) is when the sweep runs.
    expect((await call(`/api/projects/${projectId}/chats`)).status).toBe(200);
    const left = readdirSync(dir);
    expect(left).not.toContain(`${orphan.id}.png`);
    for (const id of referenced) expect(left).toContain(`${id}.png`);
  });
});
