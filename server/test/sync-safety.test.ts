import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";
import { OverleafClient } from "../src/overleaf/olclient.js";
import type { Project } from "../src/config.js";

const PORT = 4656;
const REMOTE_ID = "aaaa1111bbbb2222cccc3333";
const COOKIE = "overleaf_session2=mock-session";
const BASE = `http://127.0.0.1:${PORT}`;

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
    mock = await startMockOverleaf(PORT, REMOTE_ID);
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
    seed("main.tex", MAIN);
    seed("refs.bib", BIB);
    await git.commitAll(dir, "Initial sync from Overleaf");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Identical state on both sides, like right after a sync. */
  function seed(rel: string, text: string) {
    writeFileSync(join(dir, rel), text);
    mock.files.set(rel, Buffer.from(text));
  }

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
    expect((await git.showAtHead(dir, "fig[1].png"))?.toString()).toBe("REMOTE NEW");
    expect((await git.showAtHead(dir, "fig1.png"))?.toString()).toBe("base");
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
    expect((await git.showAtHead(dir, "figure.pdf"))?.toString()).toBe("%PDF-1.4 remote");
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

  it("git.log returns the commit history", async () => {
    const log = await git.log(dir);
    expect(log).toContain("Initial sync from Overleaf");
  });
});
