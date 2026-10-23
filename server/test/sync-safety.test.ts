import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";
import { freePort } from "../scripts/free-port.js";
import { OverleafClient } from "../src/overleaf/olclient.js";
import type { Project } from "../src/config.js";
import { buildHunkPatch, parseDiff } from "../../web/src/diff.js";

const REMOTE_ID = "aaaa1111bbbb2222cccc3333";
const COOKIE = "overleaf_session2=mock-session";
// A free port per run: parallel checkouts running the suite must not collide.
let BASE = "";

const MAIN = "\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n";
const BIB = "@article{a, title={A}, year={2000}}\n";

describe("sync safety (remote drift, conflicts, selective merge)", () => {
  let mock: MockOverleaf;
  let dataDir: string;
  let dir: string;
  let sync: typeof import("../src/sync.js");
  let git: typeof import("../src/git.js");
  let olsync: typeof import("../src/overleaf/olsync.js");

  beforeAll(async () => {
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    mock = await startMockOverleaf(port, REMOTE_ID);
  });

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    // sync.ts resolves the project dir from DATA_DIR at import time — stub +
    // reset + dynamic import, like every other test touching config.ts.
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-syncsafety-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.resetModules();
    const config = await import("../src/config.js");
    sync = await import("../src/sync.js");
    git = await import("../src/git.js");
    olsync = await import("../src/overleaf/olsync.js");
    dir = config.projectDir("drift-proj");
    mkdirSync(dir, { recursive: true });
    await git.initRepo(dir);
    mock.files.clear();
    mock.uploads.length = 0;
    mock.deletes.length = 0;
    mock.docVersions.clear();
    seed("main.tex", MAIN);
    seed("refs.bib", BIB);
    await git.commitAll(dir, "Initial sync from Overleaf");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** Identical state on both sides, like right after a sync. */
  function seed(rel: string, text: string) {
    writeFileSync(join(dir, rel), text);
    mock.files.set(rel, Buffer.from(text));
  }

  /** A path's contents as committed at HEAD. */
  const atHead = (rel: string) => execFileSync("git", ["show", `HEAD:${rel}`], { cwd: dir, encoding: "utf8" });

  /** A cookie-mode project pointing at the mock (legacy per-project cookie). */
  const project = (): Project => ({
    id: "drift-proj",
    name: "Drift Proj",
    gitUrl: `${BASE}/project/${REMOTE_ID}`,
    kind: "overleaf",
    overleafBaseUrl: BASE,
    overleafProjectId: REMOTE_ID,
    cookie: COOKIE,
    createdAt: new Date().toISOString(),
  });

  it("blocks approve when Overleaf changed a file we also edited", async () => {
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Local edit."));
    mock.files.set("main.tex", Buffer.from(MAIN.replace("Body.", "Remote edit.")));

    const before = await git.revParse(dir, "HEAD");
    await expect(sync.approve(project(), "clobber")).rejects.toMatchObject({
      name: "ApproveConflictError",
      conflicts: [{ path: "main.tex", kind: "modified" }],
    });

    // Nothing was committed or pushed; both sides keep their versions.
    expect(await git.revParse(dir, "HEAD")).toBe(before);
    expect(mock.uploads).toHaveLength(0);
    expect(mock.files.get("main.tex")?.toString()).toContain("Remote edit.");
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Local edit.");
  });

  it("reports a remote deletion of a locally modified file as deleted-remote", async () => {
    writeFileSync(join(dir, "refs.bib"), "@article{b, title={B}, year={2001}}\n");
    mock.files.delete("refs.bib");

    await expect(sync.approve(project(), "msg")).rejects.toMatchObject({
      conflicts: [{ path: "refs.bib", kind: "deleted-remote" }],
    });
    expect(mock.uploads).toHaveLength(0);
  });

  it("force approve overwrites Overleaf and backs up its versions first", async () => {
    const localMain = MAIN.replace("Body.", "Local wins.");
    const remoteMain = MAIN.replace("Body.", "Remote version.");
    writeFileSync(join(dir, "main.tex"), localMain);
    mock.files.set("main.tex", Buffer.from(remoteMain));

    const result = await sync.approve(project(), "forced", { force: true });
    expect(result.pushed).toBe(true);
    expect(result.uploaded).toContain("main.tex");
    expect(mock.files.get("main.tex")?.toString()).toBe(localMain);

    // The remote's version survived under .git (outside worktree and diff).
    const backupRoot = join(dir, ".git", "blattbot", "remote-backup");
    const stamps = readdirSync(backupRoot);
    expect(stamps).toHaveLength(1);
    expect(readFileSync(join(backupRoot, stamps[0], "main.tex"), "utf8")).toBe(remoteMain);
    expect(result.warnings?.some((w) => w.includes(backupRoot))).toBe(true);
    expect(await git.hasChanges(dir)).toBe(false);
  });

  it("absorbs remote-only changes after the push and reports them", async () => {
    const localMain = MAIN.replace("Body.", "Agent edit.");
    const remoteBib = "@article{c, title={C}, year={2024}}\n";
    writeFileSync(join(dir, "main.tex"), localMain);
    mock.files.set("refs.bib", Buffer.from(remoteBib));

    const result = await sync.approve(project(), "edit");
    expect(result.pushed).toBe(true);
    expect(result.uploaded).toEqual(["main.tex"]);
    expect(result.absorbedRemote).toEqual(["refs.bib"]);

    // Our edit reached Overleaf; the collaborator's landed as a sync commit.
    expect(mock.files.get("main.tex")?.toString()).toBe(localMain);
    expect(readFileSync(join(dir, "refs.bib"), "utf8")).toBe(remoteBib);
    expect(await git.hasChanges(dir)).toBe(false);
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" });
    expect(log.split("\n")[0]).toBe("Sync from Overleaf");
  });

  it("approves normally when the remote is unchanged", async () => {
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Simple edit."));

    const result = await sync.approve(project(), "simple");
    expect(result.pushed).toBe(true);
    expect(result.uploaded).toEqual(["main.tex"]);
    expect(result.absorbedRemote).toBeUndefined();
    expect(mock.files.get("main.tex")?.toString()).toContain("Simple edit.");
  });

  it("dirty syncIn merges remote changes to untouched files and reports drift", async () => {
    const localMain = MAIN.replace("Body.", "Pending edit.");
    const remoteMain = MAIN.replace("Body.", "Server moved on.");
    const remoteBib = "@article{d, title={D}, year={2025}}\n";
    writeFileSync(join(dir, "main.tex"), localMain); // dirty path
    mock.files.set("main.tex", Buffer.from(remoteMain)); // remote changed it too
    mock.files.set("refs.bib", Buffer.from(remoteBib)); // remote changed a clean path

    const client = new OverleafClient(BASE, COOKIE);
    const result = await olsync.syncIn(client, REMOTE_ID, dir);
    expect(result.changed).toBe(true);
    expect(result.merged).toEqual(["refs.bib"]);
    expect(result.drift).toEqual(["main.tex"]);

    // The clean file took the remote version as a commit; the dirty one kept
    // its local content and stayed uncommitted.
    expect(readFileSync(join(dir, "refs.bib"), "utf8")).toBe(remoteBib);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(localMain);
    const diff = await git.workingDiff(dir);
    expect(diff).toContain("main.tex");
    expect(diff).not.toContain("refs.bib");
  });

  it("dirty syncIn absorbs a remote deletion of an untouched file", async () => {
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Pending.")); // dirty
    mock.files.delete("refs.bib"); // remote deleted a clean path

    const client = new OverleafClient(BASE, COOKIE);
    const result = await olsync.syncIn(client, REMOTE_ID, dir);
    expect(result.merged).toEqual(["refs.bib"]);
    expect(result.drift).toBeUndefined();
    expect(existsSync(join(dir, "refs.bib"))).toBe(false);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Pending.");
    const diff = await git.workingDiff(dir);
    expect(diff).toContain("main.tex");
    expect(diff).not.toContain("refs.bib");
  });

  it("clean syncIn still applies the whole snapshot as one commit", async () => {
    mock.files.set("main.tex", Buffer.from(MAIN.replace("Body.", "Fresh remote.")));
    mock.files.set("chapters/new.tex", Buffer.from("\\section{New}\n"));

    const client = new OverleafClient(BASE, COOKIE);
    const result = await olsync.syncIn(client, REMOTE_ID, dir);
    expect(result.changed).toBe(true);
    expect(result.merged).toBeUndefined();
    expect(result.drift).toBeUndefined();
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Fresh remote.");
    expect(readFileSync(join(dir, "chapters/new.tex"), "utf8")).toContain("\\section{New}");
    expect(await git.hasChanges(dir)).toBe(false);
  });

  it("selective merge treats glob-metachar filenames literally — other files' pending edits survive", async () => {
    // Committed base for fig1.png on both sides, then a pending local edit…
    writeFileSync(join(dir, "fig1.png"), "base");
    mock.files.set("fig1.png", Buffer.from("base"));
    await git.commitAll(dir, "add fig1");
    writeFileSync(join(dir, "fig1.png"), "AGENT EDIT");
    // …while a collaborator uploads fig[1].png — as a glob pathspec that
    // pattern ALSO matches fig1.png and would sweep its unreviewed edit in.
    mock.files.set("fig[1].png", Buffer.from("REMOTE NEW"));

    const client = new OverleafClient(BASE, COOKIE);
    const result = await olsync.syncIn(client, REMOTE_ID, dir);
    expect(result.merged).toEqual(["fig[1].png"]);

    // The remote file landed as a commit; fig1.png's pending edit did NOT.
    expect(atHead("fig[1].png")).toBe("REMOTE NEW");
    expect(atHead("fig1.png")).toBe("base");
    expect(readFileSync(join(dir, "fig1.png"), "utf8")).toBe("AGENT EDIT");
    expect(await git.workingDiff(dir)).toContain("fig1.png");
  });

  it("dirty syncIn treats an uncommitted file in a brand-new directory as drift, not merge", async () => {
    // No workingDiff (intent-to-add) has run since the directory appeared —
    // plain `git status` collapses it to `?? sections/`.
    mkdirSync(join(dir, "sections"), { recursive: true });
    writeFileSync(join(dir, "sections/intro.tex"), "LOCAL DRAFT");
    mock.files.set("sections/intro.tex", Buffer.from("REMOTE VERSION"));

    const client = new OverleafClient(BASE, COOKIE);
    const result = await olsync.syncIn(client, REMOTE_ID, dir);
    expect(result.drift).toEqual(["sections/intro.tex"]);
    expect(result.merged).toBeUndefined();
    // The uncommitted local work was NOT overwritten by the remote bytes.
    expect(readFileSync(join(dir, "sections/intro.tex"), "utf8")).toBe("LOCAL DRAFT");
  });

  it("approve's conflict scan sees uncommitted files in brand-new directories", async () => {
    mkdirSync(join(dir, "sections"), { recursive: true });
    writeFileSync(join(dir, "sections/intro.tex"), "LOCAL DRAFT");
    mock.files.set("sections/intro.tex", Buffer.from("REMOTE VERSION"));

    await expect(sync.approve(project(), "msg")).rejects.toMatchObject({
      name: "ApproveConflictError",
      conflicts: [{ path: "sections/intro.tex", kind: "modified" }],
    });
    // Nothing was pushed; the collaborator's version is intact on Overleaf.
    expect(mock.uploads).toHaveLength(0);
    expect(mock.files.get("sections/intro.tex")?.toString()).toBe("REMOTE VERSION");
  });

  it("merges a remote file matched by a committed .gitignore instead of failing the sync", async () => {
    writeFileSync(join(dir, ".gitignore"), "*.pdf\n");
    mock.files.set(".gitignore", Buffer.from("*.pdf\n"));
    await git.commitAll(dir, "ignore pdfs");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Pending.")); // dirty tree
    mock.files.set("figure.pdf", Buffer.from("%PDF-1.4 remote"));

    const client = new OverleafClient(BASE, COOKIE);
    const result = await olsync.syncIn(client, REMOTE_ID, dir);
    expect(result.merged).toEqual(["figure.pdf"]);
    // Committed despite the ignore rule — the remote explicitly has the file.
    expect(atHead("figure.pdf")).toBe("%PDF-1.4 remote");
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Pending.");
  });

  it("approve survives a failing post-push absorb with a warning — the push already landed", async () => {
    // Remote turned the file "sub" into a directory ("sub/x.tex"): absorbing
    // that locally fails (mkdir over a file). The approve must still succeed —
    // commit and push happened before the reconcile ran.
    writeFileSync(join(dir, "sub"), "was a file");
    mock.files.set("sub", Buffer.from("was a file"));
    await git.commitAll(dir, "add sub");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Agent edit."));
    mock.files.delete("sub");
    mock.files.set("sub/x.tex", Buffer.from("X"));

    const result = await sync.approve(project(), "edit");
    expect(result.pushed).toBe(true);
    expect(mock.files.get("main.tex")?.toString()).toContain("Agent edit.");
    expect(result.absorbedRemote?.slice().sort()).toEqual(["sub", "sub/x.tex"]);
    expect(result.warnings?.some((w) => w.includes("run Sync to retry"))).toBe(true);
  });

  it("a push that throws midway leaves every approved change pending — no sync can overwrite it", async () => {
    // sync.ts was re-imported after resetModules, so spy on THAT module graph's client.
    const { OverleafClient: Client } = await import("../src/overleaf/olclient.js");
    const localMain = MAIN.replace("Body.", "Approved edit.");
    writeFileSync(join(dir, "main.tex"), localMain); // existing doc: in-place update, lands first
    writeFileSync(join(dir, "notes.tex"), "New file.\n"); // new file: upload, throws
    const upload = vi.spyOn(Client.prototype, "uploadFile").mockRejectedValueOnce(new Error("socket hang up"));
    const before = await git.revParse(dir, "HEAD");

    await expect(sync.approve(project(), "edit")).rejects.toThrow(/socket hang up.*still pending/);
    expect(await git.revParse(dir, "HEAD")).toBe(before);
    expect(mock.files.get("main.tex")?.toString()).toBe(localMain);
    const diff = await git.workingDiff(dir);
    expect(diff).toContain("Approved edit.");
    expect(diff).toContain("notes.tex");

    // The next sync keeps both; main.tex already matches Overleaf, so it is not drift.
    const synced = await sync.syncIn(project());
    expect(synced.drift).toBeUndefined();
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(localMain);
    expect(readFileSync(join(dir, "notes.tex"), "utf8")).toBe("New file.\n");

    upload.mockRestore();
    const retried = await sync.approve(project(), "edit");
    expect(retried.pushed).toBe(true);
    expect(mock.files.get("notes.tex")?.toString()).toBe("New file.\n");
    expect(await git.hasChanges(dir)).toBe(false);
  });

  it("a file that fails to upload stays pending while the rest of the approval is committed", async () => {
    const { OverleafClient: Client } = await import("../src/overleaf/olclient.js");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Landed."));
    writeFileSync(join(dir, "notes.tex"), "Rejected upload.\n");
    vi.spyOn(Client.prototype, "uploadFile").mockResolvedValueOnce({ ok: false, duplicate: false });
    const before = await git.revParse(dir, "HEAD");

    const result = await sync.approve(project(), "partial");
    expect(result.pushed).toBe(true);
    expect(result.pending).toEqual(["notes.tex"]);
    expect(result.warnings?.some((w) => w.includes("notes.tex") && w.includes("still pending"))).toBe(true);
    expect(await git.revParse(dir, "HEAD")).not.toBe(before);
    expect(await git.changedPaths(dir)).toEqual(["notes.tex"]);
    const log = execFileSync("git", ["log", "-1", "--name-only", "--format=%s"], { cwd: dir, encoding: "utf8" });
    expect(log).toContain("partial");
    expect(log).toContain("main.tex");
    expect(log).not.toContain("notes.tex");
  });

  it("never reverts what a co-author typed after the conflict check — the doc stays pending", async () => {
    const { OverleafClient: Client } = await import("../src/overleaf/olclient.js");
    const coAuthor = MAIN.replace("Body.", "Body. Co-author typed this.");
    const download = Client.prototype.downloadZip;
    // The co-author's keystrokes land right after approve took its snapshot.
    vi.spyOn(Client.prototype, "downloadZip").mockImplementationOnce(async function (this: any, id: string) {
      const zip = await download.call(this, id);
      mock.files.set("main.tex", Buffer.from(coAuthor));
      return zip;
    });
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Agent edit."));
    writeFileSync(join(dir, "refs.bib"), BIB + "@article{b, title={B}, year={2001}}\n");

    const result = await sync.approve(project(), "edit");
    expect(result.pending).toEqual(["main.tex"]);
    expect(result.warnings?.some((w) => w.includes("main.tex") && w.includes("collaborator"))).toBe(true);
    expect(mock.files.get("main.tex")?.toString()).toBe(coAuthor);
    expect(mock.files.get("refs.bib")?.toString()).toContain("{b,");
    expect(await git.changedPaths(dir)).toEqual(["main.tex"]);

    // The retry now sees the overlap and asks the user instead of overwriting.
    await expect(sync.approve(project(), "edit")).rejects.toMatchObject({
      name: "ApproveConflictError",
      conflicts: [{ path: "main.tex", kind: "modified" }],
    });
  });

  it("git-bridge approve un-commits when the push fails, so a retry pushes it", async () => {
    const remoteDir = join(dataDir, "remote.git");
    const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    run(dir, "clone", "--bare", dir, remoteDir);
    run(dir, "remote", "add", "origin", remoteDir);
    run(dir, "fetch", "origin");
    run(dir, "branch", `--set-upstream-to=origin/${run(dir, "branch", "--show-current").trim()}`);
    const before = await git.revParse(dir, "HEAD");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Git edit."));
    run(dir, "remote", "set-url", "origin", join(dataDir, "missing.git"));

    await expect(sync.approve({ ...project(), kind: "git", gitUrl: remoteDir }, "edit")).rejects.toThrow();
    expect(await git.revParse(dir, "HEAD")).toBe(before);
    expect(await git.changedPaths(dir)).toEqual(["main.tex"]);

    run(dir, "remote", "set-url", "origin", remoteDir);
    expect(await sync.approve({ ...project(), kind: "git", gitUrl: remoteDir }, "edit")).toEqual({ pushed: true });
    expect(run(remoteDir, "show", "HEAD:main.tex")).toContain("Git edit.");
  });

  it("reports Git autostash conflicts even when pull exits successfully", async () => {
    const remoteDir = join(dataDir, "remote.git");
    const collaborator = join(dataDir, "collaborator");
    const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    run(dir, "clone", "--bare", dir, remoteDir);
    run(dir, "remote", "add", "origin", remoteDir);
    run(dir, "fetch", "origin");
    const branch = run(dir, "branch", "--show-current").trim();
    run(dir, "branch", `--set-upstream-to=origin/${branch}`);
    run(dataDir, "clone", remoteDir, collaborator);
    run(collaborator, "config", "user.name", "Fixture");
    run(collaborator, "config", "user.email", "fixture@example.org");
    writeFileSync(join(collaborator, "main.tex"), MAIN.replace("Body.", "Remote edit."));
    run(collaborator, "commit", "-am", "Remote edit");
    run(collaborator, "push");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Local edit."));

    const result = await sync.syncIn({ ...project(), kind: "git", gitUrl: remoteDir });
    expect(result.changed).toBe(true);
    expect(result.drift).toEqual(["main.tex"]);
    expect(result.detail).toContain("Git conflicts");
    expect(run(dir, "stash", "show", "-p")).toContain("Local edit.");

    // Approve refuses to commit the conflict markers; once resolved, it pushes.
    const gitProject = { ...project(), kind: "git" as const, gitUrl: remoteDir };
    expect(result.conflicts).toEqual([{ path: "main.tex", kind: "unmerged" }]);
    // An agent turn must not start on top of the markers.
    expect(await sync.conflictMarkerPaths(gitProject)).toEqual(["main.tex"]);
    const markedText = readFileSync(join(dir, "main.tex"), "utf8");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Merged edit."));
    expect(await sync.conflictMarkerPaths(gitProject)).toEqual([]);
    // Edited away but still unmerged in the index: the next sync clears that
    // instead of failing on "unmerged files".
    expect(await git.unmergedPaths(dir)).toEqual(["main.tex"]);
    expect((await sync.syncIn(gitProject)).drift).toEqual([]);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Merged edit.");
    writeFileSync(join(dir, "main.tex"), markedText);
    await expect(sync.approve(gitProject, "resolve")).rejects.toThrow(/main\.tex.*conflict markers/);
    expect(run(remoteDir, "show", "HEAD:main.tex")).not.toContain("<<<<<<<");
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Merged edit."));
    expect(await sync.approve(gitProject, "resolve")).toEqual({ pushed: true });
    expect(run(remoteDir, "show", "HEAD:main.tex")).toContain("Merged edit.");
  });

  describe("line-level merge of Overleaf changes", () => {
    const DOC =
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "Intro line.",
        "",
        "Middle one.",
        "Middle two.",
        "Middle three.",
        "",
        "Closing line.",
        "\\end{document}",
      ].join("\n") + "\n";
    const mine = DOC.replace("Intro line.", "Intro, revised locally.");
    const theirs = DOC.replace("Closing line.", "Closing line, by a co-author.");
    const both = mine.replace("Closing line.", "Closing line, by a co-author.");
    const client = () => new OverleafClient(BASE, COOKIE);
    const log = () => execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n");

    beforeEach(async () => {
      seed("paper.tex", DOC);
      await git.commitAll(dir, "add paper");
    });

    it("sync merges edits to different lines of one file; the local edit stays pending", async () => {
      writeFileSync(join(dir, "paper.tex"), mine);
      mock.files.set("paper.tex", Buffer.from(theirs));

      const result = await olsync.syncIn(client(), REMOTE_ID, dir);
      expect(result).toMatchObject({ changed: true, merged: ["paper.tex"], rebased: ["paper.tex"], inSync: true });
      expect(result.drift).toBeUndefined();
      // HEAD = Overleaf's version; the worktree has both edits; only ours is pending.
      expect(atHead("paper.tex")).toBe(theirs);
      expect(readFileSync(join(dir, "paper.tex"), "utf8")).toBe(both);
      const diff = await git.workingDiff(dir);
      expect(diff).toContain("+Intro, revised locally.");
      expect(diff).not.toContain("co-author");
      expect(log()[0]).toBe("Sync from Overleaf");
      // Nothing went to Overleaf.
      expect(mock.files.get("paper.tex")?.toString()).toBe(theirs);
      expect(mock.docVersions.get("paper.tex") ?? 0).toBe(0);

      // Approving now pushes just our edit; Overleaf ends with both.
      const approved = await sync.approve(project(), "intro");
      expect(approved.mergedRemote).toBeUndefined();
      expect(mock.files.get("paper.tex")?.toString()).toBe(both);
    });

    it("approve merges a co-author's edit to other lines and pushes both; unapproved edits stay pending", async () => {
      writeFileSync(join(dir, "paper.tex"), mine.replace("Intro, revised locally.", "Intro, approved."));
      writeFileSync(join(dir, "notes.tex"), "Unapproved notes.\n");
      mock.files.set("paper.tex", Buffer.from(theirs));
      const expected = both.replace("Intro, revised locally.", "Intro, approved.");

      const result = await sync.approve(project(), "intro", { selection: { files: ["paper.tex"] } });
      expect(result.pushed).toBe(true);
      expect(result.mergedRemote).toEqual(["paper.tex"]);
      expect(result.updatedInPlace).toEqual(["paper.tex"]); // in place: comments survive
      expect(mock.files.get("paper.tex")?.toString()).toBe(expected);
      expect(atHead("paper.tex")).toBe(expected);
      expect(readFileSync(join(dir, "paper.tex"), "utf8")).toBe(expected);
      // The co-author's version is its own sync commit under the approval.
      expect(log().slice(0, 2)).toEqual(["intro", "Sync from Overleaf"]);
      expect(execFileSync("git", ["show", "HEAD~1:paper.tex"], { cwd: dir, encoding: "utf8" })).toBe(theirs);
      // The unapproved file stayed pending and local.
      expect(mock.files.has("notes.tex")).toBe(false);
      expect(await git.changedPaths(dir)).toEqual(["notes.tex"]);
    });

    it("same-line edits still refuse the approve, push nothing, and say what each side changed", async () => {
      writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Local edit."));
      mock.files.set("main.tex", Buffer.from(MAIN.replace("Body.", "Remote edit.")));
      const before = await git.revParse(dir, "HEAD");

      const err = await sync.approve(project(), "clash").catch((e) => e);
      expect(err).toBeInstanceOf(sync.ApproveConflictError);
      expect(err.conflicts).toEqual([
        { path: "main.tex", kind: "modified", hunks: [{ line: 3, mine: "Local edit.", base: "Body.", remote: "Remote edit." }] },
      ]);
      expect(await git.revParse(dir, "HEAD")).toBe(before);
      expect(await git.stagedPaths(dir)).toEqual([]);
      expect(mock.files.get("main.tex")?.toString()).toContain("Remote edit.");
      expect(mock.docVersions.get("main.tex") ?? 0).toBe(0);
      expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Local edit.");

      // A sync reports the same overlap as drift and leaves both versions alone.
      const synced = await olsync.syncIn(client(), REMOTE_ID, dir);
      expect(synced.drift).toEqual(["main.tex"]);
      expect(synced.conflicts).toEqual(err.conflicts);
      expect(synced.inSync).toBe(false);
      expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Local edit.");
    });

    it("binary files changed on both sides conflict without a merge attempt", async () => {
      const png = (s: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.from(s)]);
      writeFileSync(join(dir, "fig.png"), png("base"));
      mock.files.set("fig.png", png("base"));
      await git.commitAll(dir, "add figure");
      writeFileSync(join(dir, "fig.png"), png("mine"));
      mock.files.set("fig.png", png("theirs"));

      const synced = await olsync.syncIn(client(), REMOTE_ID, dir);
      expect(synced.drift).toEqual(["fig.png"]);
      expect(synced.conflicts).toEqual([{ path: "fig.png", kind: "modified", binary: true }]);
      expect(readFileSync(join(dir, "fig.png"))).toEqual(png("mine"));
      await expect(sync.approve(project(), "figure")).rejects.toMatchObject({
        name: "ApproveConflictError",
        conflicts: [{ path: "fig.png", kind: "modified", binary: true }],
      });
      expect(mock.uploads).toHaveLength(0);
      expect(mock.files.get("fig.png")).toEqual(png("theirs"));
    });

    it("forcePaths overwrites only the chosen file, backing it up first", async () => {
      const localMain = MAIN.replace("Body.", "Local main.");
      const remoteMain = MAIN.replace("Body.", "Remote main.");
      const localBib = "@article{local, title={L}, year={2001}}\n";
      const remoteBib = "@article{remote, title={R}, year={2002}}\n";
      writeFileSync(join(dir, "main.tex"), localMain);
      writeFileSync(join(dir, "refs.bib"), localBib);
      mock.files.set("main.tex", Buffer.from(remoteMain));
      mock.files.set("refs.bib", Buffer.from(remoteBib));

      // A full approval still refuses — now for refs.bib alone.
      await expect(sync.approve(project(), "all", { forcePaths: ["main.tex"] })).rejects.toMatchObject({
        conflicts: [{ path: "refs.bib", kind: "modified" }],
      });
      expect(mock.files.get("main.tex")?.toString()).toBe(remoteMain);

      const result = await sync.approve(project(), "main", { selection: { files: ["main.tex"] }, forcePaths: ["main.tex"] });
      expect(result.pushed).toBe(true);
      expect(mock.files.get("main.tex")?.toString()).toBe(localMain);
      const backupRoot = join(dir, ".git", "blattbot", "remote-backup");
      const [stamp] = readdirSync(backupRoot);
      expect(readdirSync(join(backupRoot, stamp))).toEqual(["main.tex"]);
      expect(readFileSync(join(backupRoot, stamp, "main.tex"), "utf8")).toBe(remoteMain);
      expect(result.warnings?.some((w) => w.includes("main.tex") && w.includes(backupRoot))).toBe(true);
      // refs.bib: untouched on both sides, still pending, reported as drift.
      expect(mock.files.get("refs.bib")?.toString()).toBe(remoteBib);
      expect(readFileSync(join(dir, "refs.bib"), "utf8")).toBe(localBib);
      expect(await git.changedPaths(dir)).toEqual(["refs.bib"]);
      expect(result.drift).toEqual(["refs.bib"]);
    });

    it("keeping Overleaf's version of one file leaves the other files' edits alone", async () => {
      const remoteMain = MAIN.replace("Body.", "Remote edit.");
      writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Local edit."));
      writeFileSync(join(dir, "refs.bib"), BIB + "@article{b, title={B}, year={2001}}\n");
      writeFileSync(join(dir, "notes.tex"), "New notes.\n");
      mock.files.set("main.tex", Buffer.from(remoteMain));

      expect(await sync.resolveConflicts(project(), ["main.tex"], "overleaf")).toEqual([{ path: "main.tex", conflicts: 0 }]);
      expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(remoteMain);
      expect(atHead("main.tex")).toBe(remoteMain);
      expect((await git.changedPaths(dir)).sort()).toEqual(["notes.tex", "refs.bib"]);
      expect(readFileSync(join(dir, "refs.bib"), "utf8")).toContain("{b,");
      expect(mock.files.get("refs.bib")?.toString()).toBe(BIB); // nothing pushed

      const result = await sync.approve(project(), "rest");
      expect(result.uploaded?.sort()).toEqual(["notes.tex", "refs.bib"]);
      expect(mock.files.get("main.tex")?.toString()).toBe(remoteMain);
    });

    it("resolving in the editor writes conflict markers that block approve until edited away", async () => {
      const remoteMain = MAIN.replace("Body.", "Remote edit.");
      writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Local edit."));
      writeFileSync(join(dir, "notes.tex"), "Other pending file.\n");
      mock.files.set("main.tex", Buffer.from(remoteMain));

      expect(await sync.resolveConflicts(project(), ["main.tex"], "markers")).toEqual([{ path: "main.tex", conflicts: 1, line: 3 }]);
      const marked = readFileSync(join(dir, "main.tex"), "utf8");
      expect(marked).toContain("<<<<<<< yours\nLocal edit.\n=======\nRemote edit.\n>>>>>>> Overleaf\n");
      expect(atHead("main.tex")).toBe(remoteMain);
      expect(readFileSync(join(dir, "notes.tex"), "utf8")).toBe("Other pending file.\n");

      const before = await git.revParse(dir, "HEAD");
      await expect(sync.approve(project(), "markers")).rejects.toThrow(/main\.tex.*conflict markers/);
      await expect(sync.approve(project(), "markers", { selection: { files: ["main.tex"] } })).rejects.toThrow(/conflict markers/);
      expect(await git.revParse(dir, "HEAD")).toBe(before);
      expect(await git.stagedPaths(dir)).toEqual([]);
      expect(mock.files.get("main.tex")?.toString()).toBe(remoteMain);

      const resolved = MAIN.replace("Body.", "Local and remote, combined.");
      writeFileSync(join(dir, "main.tex"), resolved);
      const result = await sync.approve(project(), "resolved");
      expect(result.pushed).toBe(true);
      expect(mock.files.get("main.tex")?.toString()).toBe(resolved);
      expect(mock.files.get("notes.tex")?.toString()).toBe("Other pending file.\n");
    });

    it("a remote deletion of an edited file cannot be resolved with markers", async () => {
      writeFileSync(join(dir, "refs.bib"), "@article{b, title={B}, year={2001}}\n");
      mock.files.delete("refs.bib");
      await expect(sync.resolveConflicts(project(), ["refs.bib"], "markers")).rejects.toThrow(/deleted on one side/);
      expect(readFileSync(join(dir, "refs.bib"), "utf8")).toContain("{b,");
      // Keeping Overleaf's version deletes it locally too.
      await sync.resolveConflicts(project(), ["refs.bib"], "overleaf");
      expect(existsSync(join(dir, "refs.bib"))).toBe(false);
      expect(await git.hasChanges(dir)).toBe(false);
    });
  });

  describe("cheap pre-turn sync", () => {
    it("a quick sync skips the download while Overleaf reports no change, and syncs in full when it does", async () => {
      const p = project();
      const start = mock.zipDownloads;
      const first = await sync.syncIn(p, { quick: true }); // nothing recorded yet: full
      expect(first.skipped).toBeUndefined();
      expect(mock.zipDownloads).toBe(start + 1);
      expect(p.remoteLastUpdated).toBe(mock.lastUpdated());
      expect(Date.now() - Date.parse(p.lastSyncAt!)).toBeLessThan(60_000);

      const second = await sync.syncIn(p, { quick: true });
      expect(second).toMatchObject({ ok: true, skipped: true, remoteLastUpdated: p.remoteLastUpdated });
      expect(mock.zipDownloads).toBe(start + 1);
      // Pending local edits alone do not force a download.
      writeFileSync(join(dir, "refs.bib"), BIB + "% local\n");
      expect((await sync.syncIn(p, { quick: true })).skipped).toBe(true);

      // Overleaf changed: full sync, which picks the change up.
      mock.files.set("main.tex", Buffer.from(MAIN.replace("Body.", "Co-author edit.")));
      const third = await sync.syncIn(p, { quick: true });
      expect(third.skipped).toBeUndefined();
      expect(mock.zipDownloads).toBe(start + 2);
      expect(readFileSync(join(dir, "main.tex"), "utf8")).toContain("Co-author edit.");
      expect((await sync.syncIn(p, { quick: true })).skipped).toBe(true);

      // A plain (non-quick) sync always downloads.
      await sync.syncIn(p);
      expect(mock.zipDownloads).toBe(start + 3);
    });

    it("falls back to a full sync on any doubt", async () => {
      const p = project();
      await sync.syncIn(p);
      const zips = () => mock.zipDownloads;
      let expected = zips();
      const expectFull = async () => {
        expect((await sync.syncIn(p, { quick: true })).skipped).toBeUndefined();
        expect(zips()).toBe(++expected);
      };
      // The last full sync is more than ten minutes old.
      p.lastSyncAt = new Date(Date.now() - sync.FULL_SYNC_MAX_AGE_MS - 1000).toISOString();
      await expectFull();
      // The project list carries no lastUpdated.
      mock.omitLastUpdated = true;
      try {
        await expectFull();
        await expectFull();
      } finally {
        mock.omitLastUpdated = false;
      }
      await expectFull(); // the record was cleared above, so once more in full
      expect((await sync.syncIn(p, { quick: true })).skipped).toBe(true);
      // HEAD moved locally since the last full sync.
      writeFileSync(join(dir, "refs.bib"), BIB + "% committed\n");
      await git.commitAll(dir, "local commit");
      await expectFull();
      // The last full sync left drift behind.
      writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Local."));
      mock.files.set("main.tex", Buffer.from(MAIN.replace("Body.", "Remote.")));
      await expectFull();
      expect(p.remoteLastUpdated).toBe(mock.lastUpdated());
      await expectFull();
    });

    it("records Overleaf's lastUpdated after a push, so the push does not read as a remote change", async () => {
      const p = project();
      await sync.syncIn(p);
      const before = p.remoteLastUpdated;
      writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Pushed."));
      const result = await sync.approve(p, "push");
      expect(result.pushed).toBe(true);
      expect(result.remoteLastUpdated).toBeTruthy();
      expect(result.remoteLastUpdated).not.toBe(before);
      expect(result.remoteLastUpdated).toBe(mock.lastUpdated());
      expect(p.remoteLastUpdated).toBe(result.remoteLastUpdated);
    });
  });

  describe("partial approval", () => {
    // Long enough that edits at the top and bottom become two separate hunks.
    const LONG = Array.from({ length: 24 }, (_, i) => `Line ${i + 1}.`).join("\n") + "\n";
    const edited = LONG.replace("Line 2.", "Line 2, revised.").replace("Line 23.", "Line 23, revised.");
    const hunkPatches = async (path: string) => {
      const file = parseDiff(await git.workingDiff(dir)).find((f) => f.path === path)!;
      return file.hunks.map((h) => buildHunkPatch(file, h));
    };

    beforeEach(async () => {
      seed("chapter.tex", LONG);
      await git.commitAll(dir, "add chapter");
      writeFileSync(join(dir, "chapter.tex"), edited);
      writeFileSync(join(dir, "notes.tex"), "New notes.\n");
    });

    it("pushes one hunk, then one file, leaving the rest pending each time", async () => {
      const [top, bottom] = await hunkPatches("chapter.tex");
      expect(bottom).toBeDefined();

      const first = await sync.approve(project(), "top edit", { selection: { patches: [top] } });
      expect(first.pushed).toBe(true);
      expect(mock.files.get("chapter.tex")?.toString()).toBe(LONG.replace("Line 2.", "Line 2, revised."));
      expect(readFileSync(join(dir, "chapter.tex"), "utf8")).toBe(edited); // worktree untouched
      expect(atHead("chapter.tex")).toContain("Line 23.\n");
      let pending = parseDiff(await git.workingDiff(dir));
      expect(pending.map((f) => f.path).sort()).toEqual(["chapter.tex", "notes.tex"]);
      expect(pending.find((f) => f.path === "chapter.tex")!.hunks).toHaveLength(1);

      await sync.approve(project(), "notes", { selection: { files: ["notes.tex"] } });
      expect(mock.files.get("notes.tex")?.toString()).toBe("New notes.\n");
      pending = parseDiff(await git.workingDiff(dir));
      expect(pending.map((f) => f.path)).toEqual(["chapter.tex"]);

      await sync.approve(project(), "rest");
      expect(mock.files.get("chapter.tex")?.toString()).toBe(edited);
      expect(await git.hasChanges(dir)).toBe(false);
    });

    it("refuses a hunk the file no longer contains, committing nothing", async () => {
      const [top] = await hunkPatches("chapter.tex");
      writeFileSync(join(dir, "chapter.tex"), edited.replace("Line 2, revised.", "Line 2, rewritten again."));
      const before = await git.revParse(dir, "HEAD");
      await expect(sync.approve(project(), "stale", { selection: { patches: [top] } })).rejects.toMatchObject({
        name: "SelectionError",
      });
      await expect(sync.approve(project(), "gone", { selection: { files: ["missing.tex"] } })).rejects.toThrow(/no pending changes/);
      expect(await git.revParse(dir, "HEAD")).toBe(before);
      expect(await git.stagedPaths(dir)).toEqual([]);
      expect(mock.files.get("chapter.tex")?.toString()).toBe(LONG);
    });

    const coAuthor = LONG.replace("Line 12.", "Co-author line 12.");

    it("merges Overleaf's edit to another region of a partly approved file and pushes only the approved hunk", async () => {
      mock.files.set("chapter.tex", Buffer.from(coAuthor));
      const [top] = await hunkPatches("chapter.tex");
      const result = await sync.approve(project(), "top", { selection: { patches: [top] } });
      expect(result.pushed).toBe(true);
      expect(result.mergedRemote).toEqual(["chapter.tex"]);
      expect(result.updatedInPlace).toEqual(["chapter.tex"]);

      // Overleaf: the co-author's line and the approved hunk — not the bottom one.
      const pushed = coAuthor.replace("Line 2.", "Line 2, revised.");
      expect(mock.files.get("chapter.tex")?.toString()).toBe(pushed);
      expect(atHead("chapter.tex")).toBe(pushed);
      // The worktree keeps the unapproved hunk pending on top of both.
      expect(readFileSync(join(dir, "chapter.tex"), "utf8")).toBe(edited.replace("Line 12.", "Co-author line 12."));
      const pending = parseDiff(await git.workingDiff(dir));
      expect(pending.map((f) => f.path).sort()).toEqual(["chapter.tex", "notes.tex"]);
      const chapter = pending.find((f) => f.path === "chapter.tex")!;
      expect(chapter.hunks).toHaveLength(1);
      expect(chapter.hunks[0].lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["Line 23, revised."]);
    });

    it("refuses a partial approval when the file's other pending edits overlap Overleaf's", async () => {
      mock.files.set("chapter.tex", Buffer.from(LONG.replace("Line 23.", "Co-author line 23.")));
      const [top] = await hunkPatches("chapter.tex");
      const before = await git.revParse(dir, "HEAD");
      await expect(sync.approve(project(), "top", { selection: { patches: [top] } })).rejects.toMatchObject({
        name: "ApproveConflictError",
        conflicts: [{ path: "chapter.tex", kind: "modified", hunks: [{ mine: "Line 23, revised.", base: "Line 23.", remote: "Co-author line 23." }] }],
      });
      expect(await git.revParse(dir, "HEAD")).toBe(before);
      expect(await git.stagedPaths(dir)).toEqual([]);
      expect(readFileSync(join(dir, "chapter.tex"), "utf8")).toBe(edited);
      expect(mock.files.get("chapter.tex")?.toString()).toBe(LONG.replace("Line 23.", "Co-author line 23."));
    });

    it("checks conflicts only for what is approved; Overleaf's edits to other pending files are merged under them", async () => {
      mock.files.set("chapter.tex", Buffer.from(coAuthor));
      const notes = await sync.approve(project(), "notes", { selection: { files: ["notes.tex"] } });
      expect(notes.pushed).toBe(true);
      expect(notes.absorbedRemote).toBeUndefined(); // chapter.tex has pending local edits
      expect(notes.mergedRemote).toEqual(["chapter.tex"]);
      // chapter.tex was not pushed; HEAD holds the co-author's version, the
      // local edits stay pending on top of it.
      expect(mock.files.get("chapter.tex")?.toString()).toBe(coAuthor);
      expect(atHead("chapter.tex")).toBe(coAuthor);
      expect(readFileSync(join(dir, "chapter.tex"), "utf8")).toBe(edited.replace("Line 12.", "Co-author line 12."));
      const diff = await git.workingDiff(dir);
      expect(diff).toContain("+Line 2, revised.");
      expect(diff).not.toContain("+Co-author line 12.");

      // Approving the rest pushes both local edits on top of the co-author's.
      const rest = await sync.approve(project(), "rest");
      expect(rest.mergedRemote).toBeUndefined();
      expect(mock.files.get("chapter.tex")?.toString()).toBe(edited.replace("Line 12.", "Co-author line 12."));
      expect(await git.hasChanges(dir)).toBe(false);
    });

    it("commits only the selection in local and git-bridge projects", async () => {
      const [top] = await hunkPatches("chapter.tex");
      expect(await sync.approve({ ...project(), kind: "local" }, "local top", { selection: { patches: [top] } })).toEqual({ pushed: false });
      expect(atHead("chapter.tex")).toContain("Line 2, revised.");
      expect(atHead("chapter.tex")).toContain("Line 23.\n");

      const remoteDir = join(dataDir, "remote.git");
      const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
      run(dir, "clone", "--bare", dir, remoteDir);
      run(dir, "remote", "add", "origin", remoteDir);
      run(dir, "fetch", "origin");
      run(dir, "branch", `--set-upstream-to=origin/${run(dir, "branch", "--show-current").trim()}`);
      const gitProject = { ...project(), kind: "git" as const, gitUrl: remoteDir };
      expect(await sync.approve(gitProject, "notes", { selection: { files: ["notes.tex"] } })).toEqual({ pushed: true });
      expect(run(remoteDir, "show", "HEAD:notes.tex")).toBe("New notes.\n");
      expect(run(remoteDir, "show", "HEAD:chapter.tex")).toContain("Line 23.\n");
      expect(readFileSync(join(dir, "chapter.tex"), "utf8")).toBe(edited); // survived the autostash
    });
  });

  it("git.log returns the commit history", async () => {
    const log = await git.log(dir);
    expect(log).toContain("Initial sync from Overleaf");
  });
});
