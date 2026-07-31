import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git.js";
import { buildHunkPatch, parseDiff } from "../../web/src/diff.js";

const BASE_LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const BASE = BASE_LINES.join("\n") + "\n";

describe("partial rejection (git helpers + hunk patch round-trip)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "blattbot-rejection-"));
    await git.initRepo(dir);
    writeFileSync(join(dir, "main.tex"), BASE);
    writeFileSync(join(dir, "refs.bib"), "% bibliography\n");
    await git.commitAll(dir, "base");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  beforeEach(async () => {
    await git.discard(dir);
  });

  it("reverse-applies one reconstructed hunk and keeps the other", async () => {
    // Two edits far enough apart to produce two hunks.
    const edited = [...BASE_LINES];
    edited[1] = "line 2 EDITED";
    edited[37] = "line 38 EDITED";
    writeFileSync(join(dir, "main.tex"), edited.join("\n") + "\n");

    const files = parseDiff(await git.workingDiff(dir));
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);

    const patch = buildHunkPatch(files[0], files[0].hunks[0]);
    await git.applyReverse(dir, patch);

    const after = readFileSync(join(dir, "main.tex"), "utf8");
    expect(after).toContain("line 2\n");
    expect(after).not.toContain("line 2 EDITED");
    expect(after).toContain("line 38 EDITED");

    const remaining = parseDiff(await git.workingDiff(dir));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].hunks).toHaveLength(1);
    expect(remaining[0].hunks[0].lines.some((l) => l.kind === "add" && l.text === "line 38 EDITED")).toBe(true);
  });

  it("reverse-applies a new-file hunk, deleting the file", async () => {
    writeFileSync(join(dir, "extra.tex"), "one\ntwo\n");
    const files = parseDiff(await git.workingDiff(dir));
    const extra = files.find((f) => f.path === "extra.tex")!;
    expect(extra.status).toBe("added");

    await git.applyReverse(dir, buildHunkPatch(extra, extra.hunks[0]));
    expect(existsSync(join(dir, "extra.tex"))).toBe(false);
    expect(parseDiff(await git.workingDiff(dir))).toHaveLength(0);
  });

  it("rejects a stale hunk patch instead of corrupting the tree", async () => {
    const edited = [...BASE_LINES];
    edited[1] = "line 2 EDITED";
    writeFileSync(join(dir, "main.tex"), edited.join("\n") + "\n");
    const files = parseDiff(await git.workingDiff(dir));
    const patch = buildHunkPatch(files[0], files[0].hunks[0]);

    await git.discard(dir); // the diff no longer matches the tree
    await expect(git.applyReverse(dir, patch)).rejects.toThrow(/apply/);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(BASE);
  });

  it("discardPath restores a tracked file from HEAD", async () => {
    writeFileSync(join(dir, "main.tex"), "clobbered\n");
    writeFileSync(join(dir, "refs.bib"), "% edited\n");
    await git.discardPath(dir, "main.tex");
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(BASE);
    // The other file's pending change is untouched.
    expect(readFileSync(join(dir, "refs.bib"), "utf8")).toBe("% edited\n");
  });

  it("discardPath deletes a new file, including intent-to-add entries", async () => {
    writeFileSync(join(dir, "brand-new.tex"), "hello\n");
    await git.workingDiff(dir); // gives it an intent-to-add index entry
    await git.discardPath(dir, "brand-new.tex");
    expect(existsSync(join(dir, "brand-new.tex"))).toBe(false);
    expect(await git.hasChanges(dir)).toBe(false);
  });

  it("fileDiff covers tracked edits and synthesizes untracked files", async () => {
    writeFileSync(join(dir, "main.tex"), BASE + "appended\n");
    const tracked = await git.fileDiff(dir, "main.tex");
    expect(tracked).toContain("diff --git a/main.tex b/main.tex");
    expect(tracked).toContain("+appended");

    writeFileSync(join(dir, "fresh.tex"), "new content\n");
    const untracked = await git.fileDiff(dir, "fresh.tex");
    expect(untracked).toContain("new file mode 100644");
    expect(untracked).toContain("+new content");
    expect(parseDiff(untracked)[0].status).toBe("added");

    expect((await git.fileDiff(dir, "refs.bib")).trim()).toBe("");
  });
});
