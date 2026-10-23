/**
 * Overleaf review state over the realtime protocol (against the mock):
 * joinDoc ranges and doc type, the comment list with line mapping and stale
 * detection, tracked-change pushes, and history-OT docs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";
import { freePort } from "../scripts/free-port.js";
import { OverleafClient, parseJoinDocAck } from "../src/overleaf/olclient.js";
import { computeTextOp, computeTextOpHunks, historyTextOperation } from "../src/overleaf/ot.js";
import * as git from "../src/git.js";

const REMOTE_ID = "cccc3333dddd4444eeee5555";
const COOKIE = "overleaf_session2=mock-session";
const ALICE = { id: "5f00000000000000000000a1", first_name: "Alice", last_name: "Author", email: "alice@example.org" };
const BOB = { id: "5f00000000000000000000b2", first_name: "", last_name: "", email: "bob@example.org" };

const INTRO = [
  "\\section{Einführung}", // non-ASCII: realtime escapes lines and ranges
  "Wir prüfen die Hypothese 🚀 hier.",
  "A middle line that nobody edits.",
  "Another untouched line.",
  "The conclusion follows.",
  "",
].join("\n");

let mock: MockOverleaf;
let client: OverleafClient;
let dataDir: string;
let dir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-olreview-data-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  mock = await startMockOverleaf(await freePort(), REMOTE_ID);
  client = new OverleafClient(`http://127.0.0.1:${mock.port}`, COOKIE);
});

afterAll(async () => {
  await mock.close();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-olreview-"));
  await git.initRepo(dir);
  for (const map of [mock.files, mock.docVersions, mock.project.ranges, mock.project.threads, mock.project.historyDocs]) map.clear();
  mock.uploads.length = 0;
  mock.deletes.length = 0;
  mock.otUpdates.length = 0;
  mock.threadsApi = true;
  mock.reviewForbidden = false;
  mock.ignoreTrackChanges = false;
  mock.failOtUpdate = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Same content locally and on Overleaf, like right after a sync. */
function seed(rel: string, content: string) {
  mkdirSync(join(dir, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "."), { recursive: true });
  writeFileSync(join(dir, rel), content);
  mock.files.set(rel, Buffer.from(content));
}

async function joinByPath(path: string) {
  const session = await client.connectRealtime(REMOTE_ID);
  try {
    const { buildTree } = await import("../src/overleaf/olclient.js");
    const id = buildTree(session.project).entities.get(path)!.id;
    return await session.joinDoc(id);
  } finally {
    session.close();
  }
}

/** Commit base, write `edited`, commit, push; returns the push result. */
async function pushEdit(rel: string, edited: string, opts: { trackChanges?: boolean } = {}) {
  const { pushChanges } = await import("../src/overleaf/olsync.js");
  await git.commitAll(dir, "base");
  const base = await git.revParse(dir, "HEAD");
  writeFileSync(join(dir, rel), edited);
  await git.commitAll(dir, "edit");
  return pushChanges(client, REMOTE_ID, dir, base, await git.revParse(dir, "HEAD"), undefined, opts);
}

describe("joinDoc ranges and doc type", () => {
  it("decodes escaped comment and tracked-change text, including non-ASCII", async () => {
    seed("intro.tex", INTRO);
    const thread = mock.addComment("intro.tex", "Hypothese 🚀", [{ content: "Zitat fehlt", user: ALICE }]);
    mock.addTrackedInsert("intro.tex", "Einführung", ALICE.id);
    const doc = await joinByPath("intro.tex");
    expect(doc.type).toBe("sharejs-text-ot");
    expect(doc.lines.join("\n")).toBe(INTRO);
    expect(doc.ranges.comments).toEqual([
      { id: thread, threadId: thread, quote: "Hypothese 🚀", offset: INTRO.indexOf("Hypothese") },
    ]);
    expect(doc.ranges.changes).toHaveLength(1);
    expect(doc.ranges.changes[0]).toMatchObject({ kind: "insert", text: "Einführung", userId: ALICE.id });
    expect(doc.ranges.changes[0].time).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("tolerates acks from older servers and malformed ranges", () => {
    expect(parseJoinDocAck("d", [null, ["a", "b"], 3])).toEqual({
      lines: ["a", "b"],
      version: 3,
      type: "sharejs-text-ot",
      ranges: { comments: [], changes: [] },
    });
    const doc = parseJoinDocAck("d", [
      null,
      ["x"],
      1,
      [],
      { comments: [{ op: { c: "q" } }, { id: "t1", op: { p: 0, c: "x", t: "t1" } }, null], changes: [{ op: { p: 0 } }, "junk"] },
    ]);
    expect(doc.ranges.comments).toEqual([{ id: "t1", threadId: "t1", quote: "x", offset: 0 }]);
    expect(doc.ranges.changes).toEqual([]);
    expect(() => parseJoinDocAck("d", [null, "not lines", 1])).toThrow(/unexpected ack/);
  });

  it("retries a history-OT doc with supportsHistoryOT and maps offsets past tracked deletes", async () => {
    seed("hist.tex", "keep this text and that\n");
    const thread = mock.addComment("hist.tex", "that");
    mock.makeHistoryOt("hist.tex", [{ at: 5, text: "OLD " }]);
    const doc = await joinByPath("hist.tex");
    expect(doc.type).toBe("history-ot");
    // Tracked-deleted text stays in the stored content, not in the visible text.
    expect(doc.lines.join("\n")).toBe("keep this text and that\n");
    expect(doc.historyContent).toBe("keep OLD this text and that\n");
    expect(doc.hiddenSpans).toEqual([{ pos: 5, length: 4 }]);
    expect(doc.ranges.comments).toEqual([
      { id: thread, threadId: thread, quote: "that", offset: "keep this text and ".length },
    ]);
    expect(doc.ranges.changes).toMatchObject([{ kind: "delete", text: "OLD ", offset: 5 }]);
  });
});

describe("comment list", () => {
  it("lists threads with authors, lines, local lines and stale flags", async () => {
    const { fetchRemoteReview, buildReview } = await import("../src/overleaf/comments.js");
    seed("intro.tex", INTRO);
    seed("chapters/two.tex", "First.\nSecond sentence here.\n");
    const t1 = mock.addComment("intro.tex", "Hypothese 🚀", [
      { content: "Please cite this.", user: ALICE, timestamp: Date.parse("2026-10-20T10:00:00Z") },
      { content: "Agreed.", user: BOB, timestamp: Date.parse("2026-10-21T09:30:00Z") },
    ]);
    const t2 = mock.addComment("intro.tex", "The conclusion follows.", [{ content: "Too abrupt.", user: ALICE }]);
    const t3 = mock.addComment("chapters/two.tex", "Second sentence", [{ content: "Old remark", user: BOB }], { resolved: true });
    // Locally: the second comment's passage is rewritten, the first moved down a line.
    writeFileSync(join(dir, "intro.tex"), "% new first line\n" + INTRO.replace("The conclusion follows.", "We conclude."));

    const remote = await fetchRemoteReview(client, REMOTE_ID);
    const review = buildReview(remote, dir);
    expect(review.threadsAvailable).toBe(true);
    expect(review.warnings).toEqual([]);
    expect(review.threads.map((t) => t.id)).toEqual([t3, t1, t2]); // by path, then position
    const [resolved, first, second] = review.threads;
    expect(first).toMatchObject({ path: "intro.tex", quote: "Hypothese 🚀", line: 2, localLine: 3, stale: false, resolved: false });
    expect(first.messages.map((m) => [m.author, m.content, m.time])).toEqual([
      ["Alice Author", "Please cite this.", "2026-10-20T10:00:00.000Z"],
      ["bob@example.org", "Agreed.", "2026-10-21T09:30:00.000Z"],
    ]);
    expect(second).toMatchObject({ line: 5, localLine: null, stale: true });
    expect(resolved).toMatchObject({ path: "chapters/two.tex", resolved: true, resolvedBy: "Mock User", line: 2, stale: false });

    const open = buildReview(remote, dir, { includeResolved: false, path: "intro.tex" });
    expect(open.threads.map((t) => t.id)).toEqual([t1, t2]);
    expect(buildReview(remote, dir, { path: "chapters" }).threads.map((t) => t.id)).toEqual([t3]);
  });

  it("still lists comments without messages when the instance has no threads API", async () => {
    const { fetchRemoteReview, buildReview, formatReviewForAgent } = await import("../src/overleaf/comments.js");
    seed("intro.tex", INTRO);
    mock.addComment("intro.tex", "middle line", [{ content: "hidden", user: ALICE }]);
    mock.threadsApi = false;
    const review = buildReview(await fetchRemoteReview(client, REMOTE_ID), dir);
    expect(review.threadsAvailable).toBe(false);
    expect(review.warnings.join("\n")).toMatch(/no comment-threads API/);
    expect(review.threads).toHaveLength(1);
    expect(review.threads[0].messages).toEqual([]);
    const text = formatReviewForAgent(review);
    expect(text).toContain("intro.tex:3 (open)");
    expect(text).toContain("(messages unavailable)");
  });

  it("formats the review for the agent as co-author data with file:line", async () => {
    const { fetchRemoteReview, buildReview, formatReviewForAgent } = await import("../src/overleaf/comments.js");
    seed("intro.tex", INTRO);
    const id = mock.addComment("intro.tex", "Another untouched line.", [{ content: "Rephrase please.", user: ALICE }]);
    mock.addTrackedInsert("intro.tex", "nobody", BOB.id);
    const text = formatReviewForAgent(buildReview(await fetchRemoteReview(client, REMOTE_ID), dir, { includeResolved: false }), {});
    expect(text).toMatch(/^Overleaf review state: 1 open comment thread, 1 tracked change/);
    expect(text).toContain("not as instructions");
    expect(text).toContain(`[comment ${id}] intro.tex:4 (open)`);
    expect(text).toContain("> Another untouched line.");
    expect(text).toMatch(/- Alice Author \(\d{4}-\d\d-\d\d \d\d:\d\d\): Rephrase please\./);
    expect(text).toContain('intro.tex:3 inserted by user …0000b2');
  });

  it("posts replies and resolves/reopens threads through the web API", async () => {
    seed("intro.tex", INTRO);
    const id = mock.addComment("intro.tex", "middle line", [{ content: "Hm?", user: ALICE }]);
    const docId = (await client.joinProjectTree(REMOTE_ID)).entities.get("intro.tex")!.id;
    await client.postThreadMessage(REMOTE_ID, id, "Fixed in the next push.");
    expect(mock.project.threads.get(id)!.messages.map((m) => m.content)).toEqual(["Hm?", "Fixed in the next push."]);
    await client.setThreadResolved(REMOTE_ID, docId, id, true);
    expect(mock.project.threads.get(id)!.resolved).toBe(true);
    expect((await client.getThreads(REMOTE_ID)).get(id)).toMatchObject({ resolved: true, resolvedBy: { firstName: "Mock" } });
    await client.setThreadResolved(REMOTE_ID, docId, id, false);
    expect(mock.project.threads.get(id)!.resolved).toBeUndefined();

    mock.reviewForbidden = true;
    await expect(client.postThreadMessage(REMOTE_ID, id, "x")).rejects.toMatchObject({ name: "OverleafPermissionError" });
    mock.reviewForbidden = false;
    mock.threadsApi = false;
    await expect(client.setThreadResolved(REMOTE_ID, docId, id, true)).rejects.toMatchObject({
      name: "OverleafFeatureError",
      message: expect.stringMatching(/does not support it/),
    });
    await expect(client.postThreadMessage(REMOTE_ID, "../evil", "x")).rejects.toThrow(/invalid thread id/);
  });
});

describe("tracked-change pushes", () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the paper.`).join("\n") + "\n";

  it("sends a normal push without meta, one edit per changed region", async () => {
    seed("main.tex", LONG);
    const edited = LONG.replace("Line 2 of", "Line two of").replace("Line 11 of", "Line eleven of");
    const result = await pushEdit("main.tex", edited);
    expect(result.warnings).toEqual([]);
    expect(result.updatedInPlace).toEqual(["main.tex"]);
    expect(mock.otUpdates).toHaveLength(1);
    expect(mock.otUpdates[0].update).not.toHaveProperty("meta");
    expect(mock.otUpdates[0].update.op).toEqual(computeTextOpHunks(LONG, edited));
    expect(mock.otUpdates[0].update.op).not.toEqual(computeTextOp(LONG, edited));
    expect(mock.files.get("main.tex")!.toString()).toBe(edited);
  });

  it("keeps a comment between two edits of a normal push", async () => {
    seed("main.tex", LONG);
    mock.addComment("main.tex", "Line 6 of the paper.", [{ content: "Check this claim.", user: ALICE }]);
    const edited = LONG.replace("Line 2 of", "Line two of").replace("Line 11 of", "Line eleven of");
    await pushEdit("main.tex", edited);
    const doc = await joinByPath("main.tex");
    const comments = doc.ranges.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].quote).toBe("Line 6 of the paper.");
    expect(edited.slice(comments[0].offset, comments[0].offset + comments[0].quote.length)).toBe("Line 6 of the paper.");
  });

  it("sends meta.tc with one change per edited region and confirms Overleaf recorded it", async () => {
    seed("main.tex", LONG);
    const comment = mock.addComment("main.tex", "Line 6 of the paper.", [{ content: "keep me", user: ALICE }]);
    const edited = LONG.replace("Line 2 of", "Line two of").replace("Line 11 of the paper.\n", "");
    const result = await pushEdit("main.tex", edited, { trackChanges: true });
    expect(result.warnings).toEqual([]);
    expect(result.updatedInPlace).toEqual(["main.tex"]);
    const { update } = mock.otUpdates[0];
    expect(update.meta.tc).toMatch(/^[0-9a-f]{18}$/);
    expect(update.op).toEqual(computeTextOpHunks(LONG, edited));
    // Text is exactly the target (tracked deletes leave the text), and the changes carry the seed.
    expect(mock.files.get("main.tex")!.toString()).toBe(edited);
    const changes = mock.project.ranges.get("main.tex")!.changes;
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.every((c) => c.id.startsWith(update.meta.tc))).toBe(true);
    expect(changes.map((c) => c.op.d ?? c.op.i)).toEqual(expect.arrayContaining(["2", "two", "Line 11 of the paper.\n"]));
    // The comment between the two regions is untouched.
    expect(mock.project.ranges.get("main.tex")!.comments).toEqual([
      { id: comment, op: { c: "Line 6 of the paper.", p: edited.indexOf("Line 6"), t: comment } },
    ]);
  });

  it("warns when the instance applies the edit but records no tracked change", async () => {
    seed("main.tex", LONG);
    mock.ignoreTrackChanges = true;
    const edited = LONG.replace("Line 3", "Line III");
    const result = await pushEdit("main.tex", edited, { trackChanges: true });
    expect(result.updatedInPlace).toEqual(["main.tex"]);
    expect(result.warnings).toEqual([
      "This Overleaf instance did not record tracked changes for main.tex; the edit was applied as a normal edit",
    ]);
    expect(mock.files.get("main.tex")!.toString()).toBe(edited);
  });

  it("says uploads and deletions cannot be tracked, and keeps a failed doc pending instead of replacing it", async () => {
    seed("main.tex", LONG);
    seed("old.tex", "obsolete\n");
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    writeFileSync(join(dir, "main.tex"), LONG.replace("Line 1 ", "Line one "));
    writeFileSync(join(dir, "new.tex"), "fresh\n");
    rmSync(join(dir, "old.tex"));
    await git.commitAll(dir, "edit");
    mock.failOtUpdate = "not authorized";
    const { pushChanges } = await import("../src/overleaf/olsync.js");
    const result = await pushChanges(client, REMOTE_ID, dir, base, await git.revParse(dir, "HEAD"), undefined, { trackChanges: true });
    expect(result.failed).toEqual(["main.tex"]);
    expect(result.uploaded).toEqual(["new.tex"]);
    expect(result.deleted).toEqual(["old.tex"]);
    const warnings = result.warnings.join("\n");
    expect(warnings).toMatch(/main\.tex: pushing it as a tracked change failed \(.*not authorized.*\) — not replaced as a whole file; still pending/);
    expect(warnings).toMatch(/new\.tex: uploaded as a whole file — .*not uploads/);
    expect(warnings).toMatch(/old\.tex: deleted on Overleaf — deleting a file cannot be a tracked change/);
    // main.tex was neither deleted nor re-uploaded.
    expect(mock.deletes).toEqual(["old.tex"]);
    expect(mock.files.get("main.tex")!.toString()).toBe(LONG);
  });
});

describe("history-OT docs", () => {
  it("edits them in place with a text operation, keeping comments and tracked deletes", async () => {
    const text = "Alpha line.\nBeta line with a comment.\nGamma line.\n";
    seed("hist.tex", text);
    const comment = mock.addComment("hist.tex", "with a comment");
    mock.makeHistoryOt("hist.tex", [{ at: text.indexOf("Gamma"), text: "Removed by Bob. " }]);
    const edited = text.replace("Alpha", "ALPHA").replace("Gamma line.", "Gamma line, extended.");
    const result = await pushEdit("hist.tex", edited);
    expect(result.warnings).toEqual([]);
    expect(result.updatedInPlace).toEqual(["hist.tex"]);
    expect(mock.uploads).toEqual([]);
    expect(mock.deletes).toEqual([]);
    const { update } = mock.otUpdates[0];
    expect(update.op).toEqual([{ textOperation: expect.any(Array) }]);
    expect(mock.files.get("hist.tex")!.toString()).toBe(edited);
    const doc = mock.project.historyDocs.get("hist.tex")!;
    expect(doc.content).toContain("Removed by Bob. ");
    expect(doc.comments[0].id).toBe(comment);
    const [range] = doc.comments[0].ranges;
    expect(doc.content.slice(range.pos, range.pos + range.length)).toBe("with a comment");
  });

  it("applies tracked-change pushes to history-OT docs as normal edits, with a warning", async () => {
    seed("hist.tex", "One.\nTwo.\n");
    mock.makeHistoryOt("hist.tex");
    const result = await pushEdit("hist.tex", "One.\nTwo, edited.\n", { trackChanges: true });
    expect(result.updatedInPlace).toEqual(["hist.tex"]);
    expect(result.warnings).toEqual([
      "hist.tex: this document uses Overleaf's newer history format, which BlattBot cannot push as tracked changes; the edit was applied as a normal edit",
    ]);
    expect(mock.otUpdates[0].update).not.toHaveProperty("meta");
  });

  it("builds operations that span the whole content and retain hidden text", () => {
    expect(historyTextOperation("abXXcd", [{ pos: 2, length: 2 }], "abcd")).toEqual([6]);
    expect(historyTextOperation("abXXcd", [{ pos: 2, length: 2 }], "aBcd")).toEqual([1, "B", -1, 4]);
    expect(historyTextOperation("abXXcd", [{ pos: 2, length: 2 }], "ad")).toEqual([1, -1, 2, -1, 1]);
    expect(historyTextOperation("", [], "new")).toEqual(["new"]);
  });
});

describe("computeTextOpHunks", () => {
  it("emits one region per changed area and transforms old into new", () => {
    const a = "one\ntwo\nthree\nfour\nfive\n";
    const b = "ONE\ntwo\nthree\nfour\nfive!\n";
    // Not one splice from "one" to "five": the lines in between are left alone.
    expect(computeTextOpHunks(a, b)).toEqual([
      { p: 0, d: "one" },
      { p: 0, i: "ONE" },
      { p: 23, i: "!" },
    ]);
    expect(computeTextOpHunks("ab\ncd\n", "aXb\ncd\nef\n")).toEqual([
      { p: 1, i: "X" },
      { p: 7, i: "ef\n" },
    ]);
    expect(computeTextOpHunks(a, a)).toEqual([]);
    expect(computeTextOpHunks("", "x\n")).toEqual([{ p: 0, i: "x\n" }]);
  });
});
