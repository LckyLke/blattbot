import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "blattbot-branch-comparison-"));
const source = join(root, "source");
const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
let repos: typeof import("../src/repositories.js");
let id: string;
let repo: import("../src/repositories.js").CodeRepository;
let fork: string;
let base: string;
let featureFirst: string;
let comparison: any;
const query = (action: string, extra = {}) => repos.queryRepository(id, {
  action, repositoryId: repo.id, commit: repo.commit, ...extra,
}) as Promise<any>;
const write = (path: string, content: string | Buffer) => writeFileSync(join(source, path), content);
const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };

beforeAll(async () => {
  vi.stubEnv("BLATTBOT_DATA_DIR", join(root, "data"));
  vi.resetModules();
  repos = await import("../src/repositories.js");
  const config = await import("../src/config.js");
  id = config.addProject({ name: "Branch changes", gitUrl: "local", kind: "local" }).id;
  mkdirSync(source);
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.org"); git("config", "user.name", "Fixture");
  write("method.py", "return mean(x)\n"); write("removed.txt", "old text\n");
  write("renamed.txt", "rename me\n"); write("image.bin", Buffer.from([0, 1, 2]));
  fork = commit("Initial implementation");
  git("checkout", "-b", "feature/method");
  write("method.py", "return sum(x)\n"); write("added.txt", "new method\n");
  featureFirst = commit("Implement sum method");
  git("rm", "removed.txt"); git("mv", "renamed.txt", "new-name.txt");
  write("image.bin", Buffer.from([0, 3, 4]));
  // Glob metacharacters that are also legal Windows filenames.
  write("literal[1].txt", "literal pathspec filename\n");
  write("literal1.txt", "glob decoy must not match\n");
  symlinkSync("/etc/passwd", join(source, "link"));
  commit("Update supporting files");
  repo = await repos.attachRepository(id, { source, ref: "feature/method" });
  // Move both refs after attachment: comparison must retain the old feature tip.
  write("later-feature.txt", "not in the attached snapshot\n"); commit("Later feature work");
  git("checkout", "main"); write("base-only.txt", "unrelated main work\n"); base = commit("Base-only work");
}, 30_000);
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("branch-introduced changes", () => {
  it("fetches missing history and compares against the merge base, keeping the attached tip fixed", async () => {
    const sourceBefore = git("status", "--porcelain");
    comparison = await query("compare", { baseRef: "main", limit: 2 });
    expect(comparison).toMatchObject({ commit: repo.commit, baseRef: "main", baseCommit: base, mergeBase: fork, nextOffset: 2 });
    const rest = await query("compare", { baseCommit: base, offset: comparison.nextOffset });
    const files = [...comparison.files, ...rest.files];
    expect(files).toEqual(expect.arrayContaining([
      { status: "M", path: "method.py" }, { status: "A", path: "added.txt" },
      { status: "D", path: "removed.txt" }, { status: "D", path: "renamed.txt" },
      { status: "A", path: "new-name.txt" }, { status: "M", path: "image.bin" },
    ]));
    expect(files.some(f => ["base-only.txt", "later-feature.txt"].includes(f.path))).toBe(false);
    expect(rest.nextOffset).toBeNull();
    expect(repos.getRepository(id, repo.id).commit).toBe(repo.commit);
    expect(git("status", "--porcelain")).toBe(sourceBefore);
    expect(git("branch", "--show-current")).toBe("main");
    const before = await query("read", { commit: comparison.mergeBase, path: "method.py" });
    expect(before.content).toBe("return mean(x)");
    expect((await query("read", { commit: base, path: "base-only.txt" })).content).toContain("unrelated");
  });
  it("paginates only commits exclusive to the recorded branch tip", async () => {
    const first = await query("history", { baseCommit: base, limit: 1 });
    expect(first.commits).toHaveLength(1);
    expect(first.commits[0]).toMatchObject({ commit: repo.commit, author: "Fixture", subject: "Update supporting files" });
    expect(first.nextOffset).toBe(1);
    const last = await query("history", { baseCommit: base, offset: first.nextOffset, limit: 1 });
    expect(last.commits).toHaveLength(1);
    expect(last.commits[0]).toMatchObject({ commit: featureFirst, subject: "Implement sum method" });
    expect(last.nextOffset).toBeNull();
  });
  it("returns complete paginated patches with source line hunk headers", async () => {
    let offset = 0;
    const pages: string[] = [];
    do {
      const page = await query("diff", { baseCommit: base, path: "method.py", limit: 2, offset });
      pages.push(page.patch); offset = page.nextOffset;
    } while (offset !== null);
    const patch = pages.join("\n");
    expect(patch).toContain("@@ -1 +1 @@");
    expect(patch).toContain("-return mean(x)\n+return sum(x)");
    expect(patch).toBe((await query("diff", { baseCommit: base, path: "method.py" })).patch);
    expect((await query("diff", { baseCommit: base, path: "removed.txt" })).patch).toContain("deleted file mode");
    expect((await query("diff", { baseCommit: base, path: "new-name.txt" })).patch).toContain("new file mode");
  });
  it("keeps binary data out of patches, treats pathspec syntax literally, and does not follow symlinks", async () => {
    expect((await query("diff", { baseCommit: base, path: "image.bin" })).patch).toContain("Binary files");
    const literal = await query("diff", { baseCommit: base, path: "literal[1].txt" });
    expect(literal.patch).toContain("+literal pathspec filename");
    expect(literal.patch).not.toContain("return sum(x)");
    expect(literal.patch).not.toContain("glob decoy must not match");
    expect((await query("diff", { baseCommit: base, path: ":(glob)*" })).patch).toBe("");
    const link = await query("diff", { baseCommit: base, path: "link" });
    expect(link.patch).toContain("+/etc/passwd");
    expect(link.patch).not.toContain("root:");
  });
  it("replays pinned comparisons after the base moves, and fetches a new base only when requested", async () => {
    write("another-base-only.txt", "more unrelated main work\n"); const nextBase = commit("More base-only work");
    const replay = await query("compare", { baseCommit: base });
    expect(replay.baseCommit).toBe(base);
    expect(replay.files.some((f: any) => f.path.includes("base-only"))).toBe(false);
    const updated = await query("compare", { baseRef: "main" });
    expect(updated.baseCommit).toBe(nextBase); expect(updated.mergeBase).toBe(fork);
    expect(updated.files).toEqual(replay.files);
    expect((await query("history", { baseCommit: base })).commits).toHaveLength(2);
  });
  it("validates comparison identity, reference arguments, ownership and diff paths", async () => {
    await expect(query("compare", { baseRef: "--upload-pack=bad" })).rejects.toThrow("revision");
    await expect(query("compare", { baseRef: "main", baseCommit: base })).rejects.toThrow("not both");
    await expect(query("history", { baseRef: "main" })).rejects.toThrow("Call compare");
    await expect(query("history", { baseCommit: "a".repeat(40) })).rejects.toThrow("recorded baseCommit");
    await expect(query("diff", { baseCommit: base })).rejects.toThrow("exact changed-file path");
    await expect(query("diff", { baseCommit: base, path: "../secret" })).rejects.toThrow("repository-relative");
    await expect(repos.queryRepository("another-project", { action: "compare", repositoryId: repo.id, commit: repo.commit, baseRef: "main" })).rejects.toThrow("not attached");
    await expect(query("compare", { commit: "a".repeat(40), baseRef: "main" })).rejects.toThrow("not an attached snapshot");
    await expect(query("compare", { baseRef: "nonexistent" })).rejects.toThrow("fetch failed");
  });
  it("handles identical endpoints and branches already contained in the base", async () => {
    for (const baseRef of [repo.commit, "feature/method"]) {
      const result = await query("compare", { baseRef });
      expect(result.files).toEqual([]); expect(result.mergeBase).toBe(repo.commit);
      expect((await query("history", { baseCommit: result.baseCommit })).commits).toEqual([]);
    }
  });
  it("preserves comparison history through attachment refreshes", async () => {
    const oldHistory = await query("history", { baseCommit: base });
    const refreshed = await repos.refreshRepository(id, repo.id);
    expect(refreshed.commit).not.toBe(repo.commit);
    expect(await query("history", { baseCommit: base })).toEqual(oldHistory);
    const next = await query("compare", { commit: refreshed.commit, baseRef: "main" });
    expect(next.files).toContainEqual({ status: "A", path: "later-feature.txt" });
    expect((await query("history", { commit: refreshed.commit, baseCommit: next.baseCommit })).commits).toHaveLength(3);
  });
  it("excludes work merged from the base and retains feature changes and merge commits", async () => {
    git("checkout", "-b", "feature/merged", "feature/method");
    git("merge", "main", "--no-ff", "-m", "Merge main into feature");
    write("after-merge.txt", "feature work after merge\n"); commit("Continue feature");
    const merged = await repos.attachRepository(id, { source, ref: "feature/merged" });
    const result = await query("compare", { repositoryId: merged.id, commit: merged.commit, baseRef: "main" });
    expect(result.mergeBase).toBe(git("rev-parse", "main"));
    expect(result.files.some((f: any) => f.path.includes("base-only"))).toBe(false);
    expect(result.files).toContainEqual({ status: "A", path: "after-merge.txt" });
    const history = await query("history", { repositoryId: merged.id, commit: merged.commit, baseCommit: result.baseCommit });
    expect(history.commits.map((c: any) => c.subject)).toContain("Merge main into feature");
    expect(history.commits.map((c: any) => c.subject)).not.toContain("Base-only work");
    git("checkout", "main");
  });
  it("rejects unrelated and ambiguous histories instead of fabricating branch changes", async () => {
    const tree = git("rev-parse", `${fork}^{tree}`);
    const unrelated = git("commit-tree", tree, "-m", "Unrelated root");
    git("update-ref", "refs/heads/unrelated", unrelated);
    await expect(query("compare", { baseRef: "unrelated" })).rejects.toThrow("no common ancestor");
    const left = git("commit-tree", tree, "-p", fork, "-m", "Left");
    const right = git("commit-tree", tree, "-p", fork, "-m", "Right");
    const leftMerge = git("commit-tree", tree, "-p", left, "-p", right, "-m", "Left merge");
    const rightMerge = git("commit-tree", tree, "-p", right, "-p", left, "-m", "Right merge");
    git("update-ref", "refs/heads/criss-left", leftMerge); git("update-ref", "refs/heads/criss-right", rightMerge);
    const criss = await repos.attachRepository(id, { source, ref: "criss-left" });
    await expect(query("compare", { repositoryId: criss.id, commit: criss.commit, baseRef: "criss-right" })).rejects.toThrow("multiple merge bases");
    expect(repos.getRepository(id, criss.id).comparisons).toBeUndefined();
  });
  it("rejects incomplete source history", async () => {
    const shallow = join(root, "shallow-source");
    execFileSync("git", ["clone", "--depth=1", "--branch", "main", pathToFileURL(source).href, shallow], { stdio: "pipe" });
    const attached = await repos.attachRepository(id, { source: shallow, ref: "main" });
    await expect(query("compare", { repositoryId: attached.id, commit: attached.commit, baseRef: "main" })).rejects.toThrow("complete history");
    expect(repos.getRepository(id, attached.id).comparisons).toBeUndefined();
  });
  it("does not invoke repository diff drivers", async () => {
    const storage = join(repos.repositoriesDir(id), repo.id);
    const marker = join(root, "driver-ran");
    execFileSync("git", ["-C", storage, "config", "diff.external", `touch ${marker}`]);
    expect((await query("diff", { baseCommit: base, path: "method.py" })).patch).toContain("+return sum(x)");
    expect(() => readFileSync(marker)).toThrow();
  });
  it("cancellation leaves comparison metadata unchanged", async () => {
    const before = repos.getRepository(id, repo.id).comparisons;
    const controller = new AbortController(); controller.abort();
    await expect(repos.queryRepository(id, { action: "compare", repositoryId: repo.id, commit: repo.commit, baseRef: "main" }, controller.signal)).rejects.toThrow();
    expect(repos.getRepository(id, repo.id).comparisons).toEqual(before);
  });
  it("exposes comparison actions to the shared Claude, OpenAI and Codex tool catalog", async () => {
    const { RESEARCH_TOOLS } = await import("../src/research/tools.js");
    const { toolDefinitions } = await import("../src/backends/openai.js");
    const { codexTools } = await import("../src/backends/codex.js");
    const shared = RESEARCH_TOOLS.find(t => t.name === "inspect_repository")!;
    expect(shared.schema.parse({ action: "compare", baseRef: "main" })).toMatchObject({ action: "compare", baseRef: "main" });
    expect(JSON.stringify(toolDefinitions(true).find(t => t.function.name === shared.name))).toContain('"baseCommit"');
    expect(JSON.stringify(codexTools().find(t => t.name === shared.name))).toContain('"compare"');
    expect(repos.repositoryManifest(id)).toContain("action=compare");
  });
});
