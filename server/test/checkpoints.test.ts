// Working-tree checkpoints: snapshots that leave the index and worktree
// alone, the turn refs and their pruning, and undo/restore by three-way merge.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cp from "../src/checkpoints.js";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
const read = (path: string) => readFileSync(join(dir, path), "utf8");
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-checkpoints-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.org");
  write("main.tex", lines(10));
  write(".gitignore", "*.aux\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));

describe("snapshotTree", () => {
  it("captures tracked, untracked and deleted files without touching the index or worktree", async () => {
    write("main.tex", lines(10).replace("line 3", "line three"));
    write("notes/new.tex", "brand new\n");
    write("build.aux", "ignored\n");
    git("add", "--intent-to-add", "notes/new.tex");
    const indexBefore = readFileSync(join(dir, ".git", "index"));
    const statusBefore = git("status", "--porcelain");

    const sha = await cp.snapshotTree(dir, "test snapshot");

    expect(readFileSync(join(dir, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(git("status", "--porcelain")).toBe(statusBefore);
    expect(git("show", `${sha}:main.tex`)).toContain("line three");
    expect(git("show", `${sha}:notes/new.tex`)).toBe("brand new\n");
    expect(() => git("show", `${sha}:build.aux`)).toThrow();
    expect(git("rev-parse", `${sha}^1`).trim()).toBe(git("rev-parse", "HEAD").trim());
    // Snapshots never move HEAD or a branch.
    expect(git("log", "--oneline").trim().split("\n")).toHaveLength(1);
  });
});

describe("turn checkpoints", () => {
  it("records before/after refs and the changed files", async () => {
    const before = await cp.beginTurnCheckpoint(dir, "chat-aa", 1);
    write("main.tex", lines(10).replace("line 2", "line two"));
    write("extra.tex", "a\nb\n");
    const turn = await cp.endTurnCheckpoint(dir, "chat-aa", 1, before);

    expect(turn.turnRef).toBe("chat-aa.1");
    expect(git("rev-parse", "refs/blattbot/turns/chat-aa/1-before").trim()).toBe(before);
    expect(git("rev-parse", "refs/blattbot/turns/chat-aa/1-after").trim()).toBe(turn.afterSha);
    expect(turn.files).toEqual([
      { path: "extra.tex", status: "added", additions: 2, deletions: 0 },
      { path: "main.tex", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(await cp.turnShas(dir, "chat-aa.1")).toEqual({ before, after: turn.afterSha });
    expect(await cp.diffBetween(dir, before, turn.afterSha)).toContain("+line two");
    expect(await cp.freeTurnNumber(dir, "chat-aa", 1)).toBe(2);
    expect(await cp.turnShas(dir, "chat-aa.7")).toBeNull();
    expect(cp.parseTurnRef("../etc.1")).toBeNull();
  });

  it("keeps only the newest turns", async () => {
    for (let n = 1; n <= 4; n++) {
      const before = await cp.beginTurnCheckpoint(dir, "chat-bb", n);
      write("main.tex", lines(10, `turn ${n}`));
      await cp.endTurnCheckpoint(dir, "chat-bb", n, before);
    }
    await cp.pruneTurnRefs(dir, 2);
    const refs = git("for-each-ref", "--format=%(refname)", "refs/blattbot/turns/").trim().split("\n").sort();
    expect(refs).toEqual([
      "refs/blattbot/turns/chat-bb/3-after",
      "refs/blattbot/turns/chat-bb/3-before",
      "refs/blattbot/turns/chat-bb/4-after",
      "refs/blattbot/turns/chat-bb/4-before",
    ]);
    await cp.deleteChatTurnRefs(dir, "chat-bb");
    expect(git("for-each-ref", "refs/blattbot/turns/").trim()).toBe("");
  });
});

describe("undoTurn", () => {
  async function agentTurn(edit: () => void): Promise<string> {
    const before = await cp.beginTurnCheckpoint(dir, "chat-cc", 1);
    edit();
    return (await cp.endTurnCheckpoint(dir, "chat-cc", 1, before)).turnRef;
  }

  it("reverts the turn's changes and keeps later edits to other lines", async () => {
    write("gone.tex", "old file\n");
    git("add", "-A");
    git("commit", "-q", "-m", "gone");
    const ref = await agentTurn(() => {
      write("main.tex", lines(10).replace("line 2", "agent two"));
      write("added.tex", "agent file\n");
      rmSync(join(dir, "gone.tex"));
    });
    // The user edits another passage after the turn.
    write("main.tex", read("main.tex").replace("line 9", "user nine"));

    const result = await cp.undoTurn(dir, ref);
    expect(result).toEqual({
      restored: ["added.tex", "gone.tex"],
      merged: ["main.tex"],
      conflicts: [],
      skipped: [],
    });
    expect(read("main.tex")).toBe(lines(10).replace("line 9", "user nine"));
    expect(existsSync(join(dir, "added.tex"))).toBe(false);
    expect(read("gone.tex")).toBe("old file\n");
  });

  it("writes conflict markers when a later edit overlaps the turn's change", async () => {
    const ref = await agentTurn(() => write("main.tex", lines(10).replace("line 5", "agent five")));
    write("main.tex", read("main.tex").replace("agent five", "user five"));

    const result = await cp.undoTurn(dir, ref);
    expect(result!.conflicts).toEqual(["main.tex"]);
    const text = read("main.tex");
    expect(text).toContain("<<<<<<< current");
    expect(text).toContain("user five");
    expect(text).toContain(">>>>>>> before the turn");
    expect(text).toContain("line 5");
  });

  it("leaves a file alone that was deleted after the turn", async () => {
    const ref = await agentTurn(() => write("main.tex", lines(10).replace("line 1", "agent one")));
    rmSync(join(dir, "main.tex"));
    const result = await cp.undoTurn(dir, ref);
    expect(result!.skipped).toEqual([{ path: "main.tex", reason: "deleted since" }]);
    expect(existsSync(join(dir, "main.tex"))).toBe(false);
  });
});

describe("discard checkpoints", () => {
  it("restores what a discard threw away, merged with edits made since", async () => {
    write("main.tex", lines(10).replace("line 2", "mine two"));
    write("draft.tex", "unsaved idea\n");
    const saved = await cp.withDiscardCheckpoint(dir, async () => {
      git("reset", "-q", "--hard", "HEAD");
      git("clean", "-fdq");
      return true;
    });
    expect(saved.discardId).toMatch(/^\d{13}-[0-9a-f]{6}$/);
    expect(saved.files!.map((f) => f.path)).toEqual(["draft.tex", "main.tex"]);
    expect(read("main.tex")).toBe(lines(10));
    // A later edit elsewhere survives the restore.
    write("main.tex", lines(10).replace("line 8", "later eight"));

    const result = await cp.restoreDiscard(dir, saved.discardId!);
    expect(result).toMatchObject({ restored: ["draft.tex"], merged: ["main.tex"], conflicts: [] });
    expect(read("main.tex")).toBe(lines(10).replace("line 2", "mine two").replace("line 8", "later eight"));
    expect(read("draft.tex")).toBe("unsaved idea\n");
    // A restore point is used once.
    expect(await cp.restoreDiscard(dir, saved.discardId!)).toBeNull();
  });

  it("saves nothing when the discard did nothing", async () => {
    expect(await cp.withDiscardCheckpoint(dir, async () => null)).toEqual({ result: null });
    expect(await cp.withDiscardCheckpoint(dir, async () => true)).toEqual({ result: true });
    expect(git("for-each-ref", "refs/blattbot/discard/").trim()).toBe("");
    expect(await cp.restoreDiscard(dir, "not-an-id")).toBeNull();
  });
});
