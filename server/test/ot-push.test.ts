import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";
import { OverleafClient } from "../src/overleaf/olclient.js";
import { pushChanges, unpackZip } from "../src/overleaf/olsync.js";
import { computeTextOp, type TextOpComponent } from "../src/overleaf/ot.js";
import * as git from "../src/git.js";

const PORT = 4657;
const REMOTE_ID = "bbbb2222cccc3333dddd4444";
const COOKIE = "overleaf_session2=mock-session";

const MAIN = "\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n";
const BIB = "@article{a, title={A}, year={2000}}\n";

/** Apply a sharejs text op the way the server would — checks delete text too. */
function applyOp(text: string, op: TextOpComponent[]): string {
  for (const c of op) {
    if (c.d !== undefined) {
      expect(text.slice(c.p, c.p + c.d.length)).toBe(c.d);
      text = text.slice(0, c.p) + text.slice(c.p + c.d.length);
    }
    if (c.i !== undefined) {
      text = text.slice(0, c.p) + c.i + text.slice(c.p);
    }
  }
  return text;
}

describe("computeTextOp", () => {
  it("returns [] for equal texts", () => {
    expect(computeTextOp("same\ntext\n", "same\ntext\n")).toEqual([]);
    expect(computeTextOp("", "")).toEqual([]);
  });

  it("emits a single insert for pure additions", () => {
    expect(computeTextOp("ab", "aXb")).toEqual([{ p: 1, i: "X" }]);
    expect(computeTextOp("", "hello")).toEqual([{ p: 0, i: "hello" }]);
    expect(computeTextOp("end", "end more")).toEqual([{ p: 3, i: " more" }]);
  });

  it("emits a single delete for pure removals", () => {
    expect(computeTextOp("aXb", "ab")).toEqual([{ p: 1, d: "X" }]);
    expect(computeTextOp("hello", "")).toEqual([{ p: 0, d: "hello" }]);
  });

  it("emits delete before insert at the same position for replacements", () => {
    expect(computeTextOp("abcdef", "abXYef")).toEqual([
      { p: 2, d: "cd" },
      { p: 2, i: "XY" },
    ]);
    expect(computeTextOp("abc", "xyz")).toEqual([
      { p: 0, d: "abc" },
      { p: 0, i: "xyz" },
    ]);
  });

  it("handles trailing-newline differences byte-faithfully", () => {
    expect(computeTextOp("a\nb", "a\nb\n")).toEqual([{ p: 3, i: "\n" }]);
    expect(computeTextOp("a\nb\n", "a\nb")).toEqual([{ p: 3, d: "\n" }]);
  });

  it("never lets prefix and suffix trims overlap on repeated content", () => {
    expect(computeTextOp("aa", "aaa")).toEqual([{ p: 2, i: "a" }]);
    expect(computeTextOp("abab", "ab")).toEqual([{ p: 2, d: "ab" }]);
  });

  it("produces ops that transform old into new", () => {
    const cases: [string, string][] = [
      [MAIN, MAIN.replace("Body.", "New body, longer than before.")],
      ["x\ny\nz\n", "x\nz\n"],
      ["aaaa", "abababa"],
      ["\n\n\n", "\n"],
      ["one", "one"],
    ];
    for (const [oldText, newText] of cases) {
      expect(applyOp(oldText, computeTextOp(oldText, newText))).toBe(newText);
    }
  });
});

describe("in-place OT doc updates (pushChanges)", () => {
  let mock: MockOverleaf;
  let dir: string;
  let client: OverleafClient;

  beforeAll(async () => {
    mock = await startMockOverleaf(PORT, REMOTE_ID);
    client = new OverleafClient(`http://127.0.0.1:${PORT}`, COOKIE);
  });

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "blattbot-otpush-"));
    await git.initRepo(dir);
    mock.files.clear();
    mock.uploads.length = 0;
    mock.deletes.length = 0;
    mock.docVersions.clear();
    mock.failOtUpdate = null;
    mock.asyncFailOtUpdate = null;
    mock.rejectRealtime = null;
    mock.conflictNextOtUpdate = false;
    mock.wsConnections = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** Identical state on both sides, like right after a sync. */
  function seed(rel: string, content: string | Buffer) {
    mkdirSync(join(dir, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "."), { recursive: true });
    writeFileSync(join(dir, rel), content);
    mock.files.set(rel, Buffer.from(content));
  }

  it("updates an existing doc in place: content lands, entity id and history survive", async () => {
    seed("main.tex", MAIN);
    seed("refs.bib", BIB);
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    const idBefore = (await client.joinProjectTree(REMOTE_ID)).entities.get("main.tex")!.id;

    const edited = MAIN.replace("Body.", "Edited in place.");
    writeFileSync(join(dir, "main.tex"), edited);
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual(["main.tex"]);
    expect(result.uploaded).toEqual(["main.tex"]);
    expect(result.deleted).toEqual([]);
    expect(result.warnings).toEqual([]);

    // The doc was edited over the websocket — no upload, no delete, same id.
    expect(mock.files.get("main.tex")?.toString()).toBe(edited);
    expect(mock.docVersions.get("main.tex")).toBe(1);
    expect(mock.uploads).toEqual([]);
    expect(mock.deletes).toEqual([]);
    expect((await client.joinProjectTree(REMOTE_ID)).entities.get("main.tex")!.id).toBe(idBefore);
  });

  it("reuses one realtime session for all docs in a push", async () => {
    seed("main.tex", MAIN);
    seed("notes.md", "old notes\n");
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "One."));
    writeFileSync(join(dir, "notes.md"), "new notes\n");
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace.sort()).toEqual(["main.tex", "notes.md"]);
    // One connection for the tree join + one shared realtime session.
    expect(mock.wsConnections).toBe(2);
  });

  it("counts a doc whose remote text already matches as updated without an op", async () => {
    seed("main.tex", MAIN);
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    const edited = MAIN.replace("Body.", "Already there.");
    writeFileSync(join(dir, "main.tex"), edited);
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");
    mock.files.set("main.tex", Buffer.from(edited)); // collaborator got there first

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual(["main.tex"]);
    expect(result.warnings).toEqual([]);
    expect(mock.docVersions.get("main.tex") ?? 0).toBe(0); // no op was applied
    expect(mock.uploads).toEqual([]);
    expect(mock.deletes).toEqual([]);
  });

  it("falls back to delete+reupload with a warning when applyOtUpdate fails", async () => {
    seed("main.tex", MAIN);
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    const edited = MAIN.replace("Body.", "Despite the failure.");
    writeFileSync(join(dir, "main.tex"), edited);
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");
    mock.failOtUpdate = "mock refused the op";

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual([]);
    expect(result.uploaded).toEqual(["main.tex"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/main\.tex: in-place update failed/);
    expect(result.warnings[0]).toContain("mock refused the op");

    // The content still landed, via the old duplicate-replace path.
    expect(mock.files.get("main.tex")?.toString()).toBe(edited);
    expect(mock.deletes).toEqual(["main.tex"]);
    expect(mock.uploads.map((u) => u.path)).toEqual(["main.tex"]);
  });

  it("retries once with a fresh version on a version conflict", async () => {
    seed("main.tex", MAIN);
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    const edited = MAIN.replace("Body.", "Second try wins.");
    writeFileSync(join(dir, "main.tex"), edited);
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");
    mock.conflictNextOtUpdate = true; // a collaborator op lands just before ours

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual(["main.tex"]);
    expect(result.warnings).toEqual([]);
    expect(mock.files.get("main.tex")?.toString()).toBe(edited);
    expect(mock.docVersions.get("main.tex")).toBe(2); // conflict bump + our retry
    expect(mock.deletes).toEqual([]);
  });

  it("keeps upload for new files and binaries, and delete for deletions", async () => {
    seed("main.tex", MAIN);
    seed("refs.bib", BIB);
    seed("figures/plot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");

    writeFileSync(join(dir, "figures/plot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    mkdirSync(join(dir, "chapters"), { recursive: true });
    writeFileSync(join(dir, "chapters/new.tex"), "\\section{New}\n");
    rmSync(join(dir, "refs.bib"));
    await git.commitAll(dir, "restructure");
    const head = await git.revParse(dir, "HEAD");

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual([]);
    expect(result.deleted).toEqual(["refs.bib"]);
    expect(result.uploaded.sort()).toEqual(["chapters/new.tex", "figures/plot.png"]);
    expect(result.warnings).toEqual([]);

    expect(mock.files.has("refs.bib")).toBe(false);
    expect(mock.files.get("chapters/new.tex")?.toString()).toBe("\\section{New}\n");
    expect(mock.files.get("figures/plot.png")).toHaveLength(6);
    // The binary replacement still goes through duplicate → delete → reupload.
    expect(mock.deletes).toEqual(expect.arrayContaining(["refs.bib", "figures/plot.png"]));
  });

  it("round-trips non-ASCII text through in-place updates (realtime line encoding)", async () => {
    // Real Overleaf transports joinDoc lines UTF-8-escaped per line; a client
    // that skips the decode diffs mojibake and its delete op cannot match.
    const original = "Einführung 🚀\nFür die Prüfung.\n";
    const edited = "Einführung 🚀\nFür die Prüfung. Neuer Satz.\n";
    seed("umlaut.tex", original);
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    writeFileSync(join(dir, "umlaut.tex"), edited);
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual(["umlaut.tex"]);
    expect(result.warnings).toEqual([]);
    expect(mock.uploads).toEqual([]);
    expect(mock.deletes).toEqual([]);

    // Byte-identical in the stored doc and in the zip the next sync downloads.
    expect(mock.files.get("umlaut.tex")?.equals(Buffer.from(edited))).toBe(true);
    expect(mock.docVersions.get("umlaut.tex")).toBe(1);
    const zipped = unpackZip(await client.downloadZip(REMOTE_ID));
    expect(zipped.get("umlaut.tex")?.equals(Buffer.from(edited))).toBe(true);
  });

  it("falls back to upload when the ack lands but the apply fails asynchronously", async () => {
    // Real CE acks the ENQUEUE; a genuine apply failure arrives later as
    // otUpdateError. The post-ack verification must catch it.
    seed("main.tex", MAIN);
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    const edited = MAIN.replace("Body.", "Enqueued but rejected.");
    writeFileSync(join(dir, "main.tex"), edited);
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");
    mock.asyncFailOtUpdate = "rejected after enqueue";

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual([]);
    expect(result.uploaded).toEqual(["main.tex"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/main\.tex: in-place update failed/);
    expect(result.warnings[0]).toContain("may not survive");

    // The content still landed, via the delete+reupload path.
    expect(mock.files.get("main.tex")?.toString()).toBe(edited);
    expect(mock.deletes).toEqual(["main.tex"]);
    expect(mock.uploads.map((u) => u.path)).toEqual(["main.tex"]);
  });

  it("fails fast with the server's reason when the realtime join is rejected", async () => {
    mock.rejectRealtime = "not authorized";
    const started = Date.now();
    await expect(client.joinProjectTree(REMOTE_ID)).rejects.toThrow(/not authorized/);
    // Immediate, not the 15s tree-timeout or a generic close error.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("falls back to upload for a doc-typed path that is not valid UTF-8", async () => {
    seed("weird.tex", Buffer.from([0x41, 0xff, 0xfe, 0x0a]));
    await git.commitAll(dir, "base");
    const base = await git.revParse(dir, "HEAD");
    const replacement = Buffer.from([0x42, 0xfe, 0xff]);
    writeFileSync(join(dir, "weird.tex"), replacement);
    await git.commitAll(dir, "edit");
    const head = await git.revParse(dir, "HEAD");

    const result = await pushChanges(client, REMOTE_ID, dir, base, head);
    expect(result.updatedInPlace).toEqual([]);
    expect(result.uploaded).toEqual(["weird.tex"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/weird\.tex: not valid UTF-8/);
    expect(mock.files.get("weird.tex")?.equals(replacement)).toBe(true);
    expect(mock.deletes).toEqual(["weird.tex"]);
  });
});
