import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../src/config.js";

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const BASE = LINES.join("\n") + "\n";
const withLine = (text: string, n: number, value: string) => {
  const lines = text.split("\n");
  lines[n - 1] = value;
  return lines.join("\n");
};

describe("history", () => {
  let dataDir: string;
  let dir: string;
  let globalConfig: string;
  let config: typeof import("../src/config.js");
  let git: typeof import("../src/git.js");
  let history: typeof import("../src/history.js");

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-history-"));
    globalConfig = join(dataDir, "gitconfig");
    writeFileSync(globalConfig, "");
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    vi.resetModules();
    config = await import("../src/config.js");
    git = await import("../src/git.js");
    history = await import("../src/history.js");
    dir = config.projectDir("hist");
    mkdirSync(dir, { recursive: true });
    await git.initRepo(dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const project = (kind: Project["kind"] = "overleaf"): Project => ({
    id: "hist",
    name: "History",
    gitUrl: "",
    kind,
    createdAt: new Date().toISOString(),
  });
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (rel: string, text: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
  const head = () => sh("rev-parse", "HEAD").trim();

  /** A typical cookie-mode project: import, an approval, a co-author sync. */
  async function typicalHistory() {
    write("main.tex", BASE);
    write("refs.bib", "% refs\n");
    await git.commitAll(dir, "Initial sync from Overleaf", git.OVERLEAF_AUTHOR);
    write("main.tex", withLine(BASE, 2, "line 2 by the agent"));
    await git.commitAll(
      dir,
      history.withTrailers("Agent: tighten line 2", { "BlattBot-Kind": "approve", "BlattBot-Chat": "chat-1" }),
      { name: "Ada Author", email: "ada@example.org" },
    );
    write("refs.bib", "% refs\n@misc{x}\n");
    await git.commitAll(dir, "Sync from Overleaf", git.OVERLEAF_AUTHOR);
  }

  describe("commit messages", () => {
    it("adds trailers as their own paragraph and parses them back", () => {
      const message = history.withTrailers("Fix intro\n\nLonger body.", {
        "BlattBot-Kind": "approve",
        "BlattBot-Chat": "chat-ab12",
        "BlattBot-Reverts": undefined,
      });
      expect(message).toBe("Fix intro\n\nLonger body.\n\nBlattBot-Kind: approve\nBlattBot-Chat: chat-ab12");
      expect(history.splitTrailers(message)).toEqual({
        text: "Fix intro\n\nLonger body.",
        trailers: { "BlattBot-Kind": "approve", "BlattBot-Chat": "chat-ab12" },
      });
      // A last paragraph that is not purely BlattBot trailers stays text.
      expect(history.splitTrailers("Subject\n\nSigned-off-by: someone").trailers).toEqual({});
    });
  });

  describe("listing", () => {
    it("lists commits newest first with kinds, authors, files and line counts", async () => {
      await typicalHistory();
      const page = await history.listHistory(project());
      expect(page.head).toBe(head());
      expect(page.nextOffset).toBeNull();
      expect(page.commits.map((c) => [c.kind, c.subject])).toEqual([
        ["sync", "Sync from Overleaf"],
        ["approve", "Agent: tighten line 2"],
        ["sync", "Initial sync from Overleaf"],
      ]);
      const [sync, approve] = page.commits;
      expect(sync.author).toEqual({ name: "Overleaf", email: "overleaf@localhost" });
      expect(sync.files).toEqual([{ path: "refs.bib", additions: 1, deletions: 0 }]);
      expect(approve).toMatchObject({
        author: { name: "Ada Author", email: "ada@example.org" },
        chatId: "chat-1",
        body: "",
        additions: 1,
        deletions: 1,
        short: approve.sha.slice(0, 7),
      });
      expect(Date.parse(approve.time)).not.toBeNaN();
    });

    it("pages stably from a fixed head and filters by kind", async () => {
      await typicalHistory();
      const first = await history.listHistory(project(), { limit: 2 });
      expect(first.commits).toHaveLength(2);
      expect(first.nextOffset).toBe(2);
      // A commit landing between pages does not shift the next page.
      write("main.tex", BASE);
      await git.commitAll(dir, "Sync from Overleaf", git.OVERLEAF_AUTHOR);
      const second = await history.listHistory(project(), { limit: 2, offset: first.nextOffset!, head: first.head! });
      expect(second.commits.map((c) => c.subject)).toEqual(["Initial sync from Overleaf"]);
      expect(second.nextOffset).toBeNull();

      const incoming = await history.listHistory(project(), { filter: "sync" });
      expect(incoming.commits.map((c) => c.kind)).toEqual(["sync", "sync", "sync"]);
      const mine = await history.listHistory(project(), { filter: "mine" });
      expect(mine.commits.map((c) => c.subject)).toEqual(["Agent: tighten line 2"]);
      const one = await history.listHistory(project(), { filter: "sync", limit: 1 });
      expect(one.commits).toHaveLength(1);
      expect(one.nextOffset).toBe(1);
    });

    it("classifies old commits without trailers, reverts, merges, and local projects", async () => {
      write("main.tex", BASE);
      await git.commitAll(dir, "Initial sync from Overleaf"); // old: authored BlattBot
      write("main.tex", withLine(BASE, 3, "x"));
      await git.commitAll(dir, "BlattBot edit");
      write("main.tex", withLine(BASE, 3, "y"));
      await git.commitAll(dir, history.withTrailers('Revert "BlattBot edit"', { "BlattBot-Kind": "revert", "BlattBot-Reverts": "abcdef1" }));
      // A merge commit.
      sh("checkout", "-q", "-b", "side");
      write("side.tex", "side\n");
      await git.commitAll(dir, "side work");
      sh("checkout", "-q", "master");
      write("other.tex", "other\n");
      await git.commitAll(dir, "other work");
      sh("-c", "user.name=T", "-c", "user.email=t@x", "merge", "-q", "--no-ff", "-m", "Merge side", "side");

      const kinds = (await history.listHistory(project())).commits.map((c) => [c.subject, c.kind]);
      expect(kinds).toEqual([
        ["Merge side", "other"],
        ["other work", "approve"],
        ["side work", "approve"],
        ['Revert "BlattBot edit"', "revert"],
        ["BlattBot edit", "approve"],
        ["Initial sync from Overleaf", "sync"],
      ]);
      const revert = (await history.listHistory(project(), { filter: "mine" })).commits.find((c) => c.kind === "revert")!;
      expect(revert.reverts).toEqual(["abcdef1"]);
      // In a local project nothing is pushed: approvals are local commits.
      const local = (await history.listHistory(project("local"))).commits.map((c) => c.kind);
      expect(local).toEqual(["other", "local", "local", "revert", "local", "sync"]);
    });

    it("tells pulled remote commits from unpushed local ones in git projects", async () => {
      const remote = join(dataDir, "remote.git");
      execFileSync("git", ["init", "-q", "--bare", "-b", "master", remote]);
      const seed = join(dataDir, "seed");
      execFileSync("git", ["clone", "-q", remote, seed], { stdio: "pipe" });
      writeFileSync(join(seed, "main.tex"), BASE);
      execFileSync("git", ["-C", seed, "add", "-A"]);
      execFileSync("git", ["-C", seed, "-c", "user.name=Co Author", "-c", "user.email=co@example.org", "commit", "-qm", "co-author edit"]);
      execFileSync("git", ["-C", seed, "push", "-q", "origin", "master"]);
      rmSync(dir, { recursive: true, force: true });
      await git.clone(remote, undefined, dir);
      write("main.tex", withLine(BASE, 1, "mine"));
      await git.commitAll(dir, history.withTrailers("My change", { "BlattBot-Kind": "approve" }));
      const commits = (await history.listHistory(project("git"))).commits;
      expect(commits.map((c) => [c.subject, c.kind])).toEqual([
        ["My change", "local"], // not pushed yet
        ["co-author edit", "sync"],
      ]);
      sh("push", "-q", "origin", "HEAD");
      expect((await history.listHistory(project("git"))).commits[0].kind).toBe("approve");
    });

    it("counts unread incoming commits since the last one seen", async () => {
      await typicalHistory();
      const seen = (await history.listHistory(project())).commits[2].sha; // the import
      expect(await history.unreadSince(project(), seen)).toEqual({ head: head(), unread: 1 });
      expect((await history.unreadSince(project(), head())).unread).toBe(0);
      expect((await history.unreadSince(project())).unread).toBe(0);
      expect((await history.unreadSince(project(), "0000000")).unread).toBe(0);
    });

    it("handles a repository without commits", async () => {
      expect(await history.listHistory(project())).toEqual({ head: null, commits: [], nextOffset: null });
      expect(await history.unreadSince(project(), "abcdef0")).toEqual({ head: null, unread: 0 });
    });
  });

  describe("commit diff", () => {
    it("returns one commit's unified diff, also for the first commit and renames", async () => {
      await typicalHistory();
      const [sync, approve, initial] = (await history.listHistory(project())).commits;
      const detail = await history.commitDetail(project(), approve.sha);
      expect(detail.commit.sha).toBe(approve.sha);
      expect(detail.truncated).toBe(false);
      expect(detail.diff).toContain("diff --git a/main.tex b/main.tex");
      expect(detail.diff).toContain("-line 2\n+line 2 by the agent");
      expect(detail.diff).not.toContain("refs.bib");
      expect((await history.commitDetail(project(), sync.short)).diff).toContain("+@misc{x}");
      const root = await history.commitDetail(project(), initial.sha);
      expect(root.diff).toContain("new file mode");
      expect(root.diff).toContain("+line 40");

      mkdirSync(join(dir, "bib"));
      sh("mv", "refs.bib", "bib/refs.bib");
      await git.commitAll(dir, "Move bibliography");
      const moved = (await history.listHistory(project())).commits[0];
      expect(moved.files).toEqual([{ path: "bib/refs.bib", oldPath: "refs.bib", additions: 0, deletions: 0 }]);
      expect((await history.commitDetail(project(), moved.sha)).diff).toContain("rename to bib/refs.bib");

      await expect(history.commitDetail(project(), "0000000")).rejects.toMatchObject({ status: 404 });
    });

    it("cuts oversized diffs at a file boundary", () => {
      const diff = "diff --git a/a b/a\n+aaaa\ndiff --git a/b b/b\n+bbbbbbbb\n";
      expect(history.truncateDiff(diff, 30)).toEqual({ diff: "diff --git a/a b/a\n+aaaa\n", truncated: true });
      expect(history.truncateDiff(diff)).toEqual({ diff, truncated: false });
    });
  });

  describe("backups", () => {
    it("lists force-approve backups newest first and serves their files", () => {
      const root = join(dir, ".git", "blattbot", "remote-backup");
      for (const [stamp, rel, text] of [
        ["2026-10-20T09-15-00.000Z", "main.tex", "old main"],
        ["2026-10-22T18-01-02.345Z", "sections/intro.tex", "old intro"],
        ["2026-10-22T18-01-02.345Z", "main.tex", "newer main"],
      ]) {
        mkdirSync(join(root, stamp, rel, ".."), { recursive: true });
        writeFileSync(join(root, stamp, rel), text);
      }
      mkdirSync(join(root, "not-a-stamp"), { recursive: true });
      expect(history.listBackups(dir)).toEqual([
        {
          stamp: "2026-10-22T18-01-02.345Z",
          at: "2026-10-22T18:01:02.345Z",
          files: [
            { path: "main.tex", size: 10 },
            { path: "sections/intro.tex", size: 9 },
          ],
        },
        { stamp: "2026-10-20T09-15-00.000Z", at: "2026-10-20T09:15:00.000Z", files: [{ path: "main.tex", size: 8 }] },
      ]);
      expect(history.readBackupFile(dir, "2026-10-22T18-01-02.345Z", "sections/intro.tex")?.toString()).toBe("old intro");
      expect(history.readBackupFile(dir, "2026-10-22T18-01-02.345Z", "../2026-10-20T09-15-00.000Z/main.tex")).toBeNull();
      expect(history.readBackupFile(dir, "2026-10-22T18-01-02.345Z", "../../../config")).toBeNull();
      expect(history.readBackupFile(dir, "..", "config")).toBeNull();
      expect(history.readBackupFile(dir, "2026-10-22T18-01-02.345Z", "sections")).toBeNull();
      expect(history.listBackups(join(dataDir, "nowhere"))).toEqual([]);
    });
  });

  describe("revert", () => {
    it("writes the reverse of a commit as pending changes without committing", async () => {
      await typicalHistory();
      const approve = (await history.listHistory(project(), { filter: "mine" })).commits[0];
      const before = head();
      const result = await history.revertCommit(project(), approve.sha);
      expect(result).toMatchObject({
        sha: approve.sha,
        changed: ["main.tex"],
        conflicts: [],
        message: 'Revert "Agent: tighten line 2"',
      });
      expect(read("main.tex")).toBe(BASE);
      expect(head()).toBe(before);
      expect(await git.changedPaths(dir)).toEqual(["main.tex"]);
      expect(await history.pendingReverts(dir)).toMatchObject([{ sha: approve.sha, paths: ["main.tex"], conflictPaths: [] }]);
      // Reverting again changes nothing: the files already match.
      expect((await history.revertCommit(project(), approve.sha)).changed).toEqual([]);
      // Discarding the pending changes forgets the revert.
      await git.discard(dir);
      expect(await history.pendingReverts(dir)).toEqual([]);
    });

    it("keeps later edits on other lines, committed or pending", async () => {
      await typicalHistory();
      const approve = (await history.listHistory(project(), { filter: "mine" })).commits[0];
      write("main.tex", withLine(withLine(BASE, 2, "line 2 by the agent"), 30, "line 30 later"));
      await git.commitAll(dir, "Later edit");
      write("main.tex", withLine(withLine(withLine(BASE, 2, "line 2 by the agent"), 30, "line 30 later"), 38, "pending 38"));
      const result = await history.revertCommit(project(), approve.sha);
      expect(result.conflicts).toEqual([]);
      expect(read("main.tex")).toBe(withLine(withLine(BASE, 30, "line 30 later"), 38, "pending 38"));
    });

    it("marks and reports conflicts with later edits to the same lines", async () => {
      await typicalHistory();
      const approve = (await history.listHistory(project(), { filter: "mine" })).commits[0];
      write("main.tex", withLine(BASE, 2, "line 2 rewritten later"));
      await git.commitAll(dir, "Later rewrite");
      const result = await history.revertCommit(project(), approve.sha);
      expect(result.changed).toEqual(["main.tex"]);
      expect(result.conflicts).toEqual([
        { path: "main.tex", reason: expect.stringMatching(/1 conflict with later edits/), markers: true },
      ]);
      const text = read("main.tex");
      expect(text).toContain("<<<<<<< current\nline 2 rewritten later\n=======\nline 2\n>>>>>>> before " + approve.short);
      expect((await history.pendingReverts(dir))[0].conflictPaths).toEqual(["main.tex"]);
    });

    it("deletes files the commit added and restores files it deleted", async () => {
      write("main.tex", BASE);
      write("old.tex", "old\n");
      await git.commitAll(dir, "base");
      sh("rm", "-q", "old.tex");
      write("new.tex", "new\n");
      write("edited.tex", "v1\n");
      await git.commitAll(dir, "add and delete");
      const target = head();
      write("edited.tex", "v2\n");
      await git.commitAll(dir, "edit the added file");
      const result = await history.revertCommit(project(), target);
      expect(result.changed.sort()).toEqual(["new.tex", "old.tex"]);
      expect(existsSync(join(dir, "new.tex"))).toBe(false);
      expect(read("old.tex")).toBe("old\n");
      // Edited since it was added: kept, and reported.
      expect(read("edited.tex")).toBe("v2\n");
      expect(result.conflicts).toEqual([
        { path: "edited.tex", reason: "edited since this commit added it — not deleted", markers: false },
      ]);
    });

    it("refuses merge commits, the first commit, and unknown commits", async () => {
      write("main.tex", BASE);
      await git.commitAll(dir, "base");
      const root = head();
      sh("checkout", "-q", "-b", "side");
      write("side.tex", "side\n");
      await git.commitAll(dir, "side");
      sh("checkout", "-q", "master");
      write("other.tex", "other\n");
      await git.commitAll(dir, "other");
      sh("-c", "user.name=T", "-c", "user.email=t@x", "merge", "-q", "--no-ff", "-m", "Merge side", "side");
      await expect(history.revertCommit(project(), head())).rejects.toMatchObject({
        status: 422,
        message: expect.stringMatching(/merge commit/),
      });
      await expect(history.revertCommit(project(), root)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/first commit/) });
      await expect(history.revertCommit(project(), "abcdef0123")).rejects.toMatchObject({ status: 404 });
      expect(await git.hasChanges(dir)).toBe(false);
    });

    it.skipIf(process.platform === "win32")("never writes through a folder that became a symlink", async () => {
      write("main.tex", BASE);
      write("sub/x.tex", "v1\n");
      await git.commitAll(dir, "base");
      write("sub/x.tex", "v2\n");
      await git.commitAll(dir, "edit x");
      const target = head();
      const outside = join(dataDir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "x.tex"), "v2\n");
      rmSync(join(dir, "sub"), { recursive: true });
      symlinkSync(outside, join(dir, "sub"));
      const result = await history.revertCommit(project(), target);
      expect(result.changed).toEqual([]);
      expect(result.conflicts).toEqual([{ path: "sub/x.tex", reason: expect.stringMatching(/outside the project/), markers: false }]);
      expect(readFileSync(join(outside, "x.tex"), "utf8")).toBe("v2\n");
    });

    it("merges binary files only when they were not changed since", async () => {
      write("fig.png", "\0png-v1");
      await git.commitAll(dir, "base");
      write("fig.png", "\0png-v2");
      await git.commitAll(dir, "new figure");
      const target = head();
      expect((await history.revertCommit(project(), target)).changed).toEqual(["fig.png"]);
      expect(read("fig.png")).toBe("\0png-v1");
      await git.discard(dir);
      write("fig.png", "\0png-v3");
      const kept = await history.revertCommit(project(), target);
      expect(kept.changed).toEqual([]);
      expect(kept.conflicts[0]).toMatchObject({ path: "fig.png", markers: false });
    });
  });

  describe("attribution", () => {
    it("uses the user's global git identity for approvals when it is complete", async () => {
      expect(await git.approverIdentity()).toEqual({ name: "BlattBot", email: "blattbot@localhost" });
      writeFileSync(globalConfig, "[user]\n\tname = Grace Hopper\n");
      git.resetApproverIdentity();
      expect((await git.approverIdentity()).name).toBe("BlattBot"); // no email: not used
      writeFileSync(globalConfig, "[user]\n\tname = Grace Hopper\n\temail = grace@example.org\n");
      git.resetApproverIdentity();
      expect(await git.approverIdentity()).toEqual({ name: "Grace Hopper", email: "grace@example.org" });
      // Read once: later changes need a reset.
      writeFileSync(globalConfig, "");
      expect((await git.approverIdentity()).name).toBe("Grace Hopper");
    });

    it("authors approval commits as the user and sync commits as Overleaf", async () => {
      writeFileSync(globalConfig, "[user]\n\tname = Grace Hopper\n\temail = grace@example.org\n");
      const sync = await import("../src/sync.js");
      const olsync = await import("../src/overleaf/olsync.js");
      await olsync.applySnapshot(dir, new Map([["main.tex", Buffer.from(BASE)]]), "Initial sync from Overleaf");
      write("main.tex", withLine(BASE, 4, "approved"));
      await sync.approve(project("local"), history.withTrailers("Manual edits", { "BlattBot-Kind": "local" }));
      write("draft.tex", "pending\n");
      await olsync.mergeRemotePaths(dir, new Map([["main.tex", Buffer.from(withLine(BASE, 4, "remote"))]]), ["main.tex"]);
      const authors = sh("log", "--format=%an <%ae> | %cn | %s").trim().split("\n");
      expect(authors).toEqual([
        "Overleaf <overleaf@localhost> | BlattBot | Sync from Overleaf",
        "Grace Hopper <grace@example.org> | BlattBot | Manual edits",
        "Overleaf <overleaf@localhost> | BlattBot | Initial sync from Overleaf",
      ]);
      expect(sh("log", "-1", "--skip=1", "--format=%B")).toContain("BlattBot-Kind: local");
      expect(read("draft.tex")).toBe("pending\n"); // the selective sync left it pending
    });
  });
});
