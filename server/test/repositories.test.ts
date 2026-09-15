import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "blattbot-git-evidence-"));
const source = join(root, "source");
let repos: typeof import("../src/repositories.js");
let evidence: typeof import("../src/research/code-evidence.js");
let config: typeof import("../src/config.js");
let id: string;
let dir: string;
let attached: import("../src/repositories.js").CodeRepository;
const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
const original = "def loss(x):\n    return x.mean()\n";
const quote = "We use the mean loss over the batch.";
beforeAll(async () => {
  vi.stubEnv("BLATTBOT_DATA_DIR", join(root, "data"));
  vi.resetModules();
  repos = await import("../src/repositories.js");
  config = await import("../src/config.js");
  evidence = await import("../src/research/code-evidence.js");
  id = config.addProject({ name: "Code evidence", gitUrl: "local", kind: "local" }).id;
  dir = config.projectDir(id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tex"), quote);
  mkdirSync(join(source, "src"), { recursive: true });
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.org"); git("config", "user.name", "Fixture");
  writeFileSync(join(source, "src/loss.py"), original);
  writeFileSync(join(source, "config.json"), '{"reduction":"mean"}\n');
  writeFileSync(join(source, ".hidden-config"), "batch_size=16\n");
  writeFileSync(join(source, "data.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(source, "model.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1000\n");
  writeFileSync(join(source, "empty.txt"), "");
  writeFileSync(join(source, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  symlinkSync("/etc/passwd", join(source, "outside"));
  git("add", "."); git("commit", "-m", "Mean reduction");
  git("branch", "feature/mean");
  attached = await repos.attachRepository(id, { source, ref: "main" });
}, 30_000);
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const read = (path: string, extra = {}) => repos.readRepositoryFile(id, { repositoryId: attached.id, commit: attached.commit, path, ...extra });
const claim = (extra = {}) => ({ file: "main.tex", quote, claimKind: "implementation", evidence: [{ repositoryId: attached.id, commit: attached.commit, path: "src/loss.py", startLine: 1, endLine: 2, role: "implementation" }], ...extra });
const judgment = (extra = {}) => JSON.stringify({ claimKind: "implementation", verdict: "supported", explanation: "The implementation reduces the batch with mean.", evidence: [{ index: 0, quote: "return x.mean()" }], limitations: ["The active call site was not inspected."], nextChecks: ["Trace the training call site."], ...extra });

describe("immutable Git repository access", () => {
  it("browses local folders with Git badges and resolves a subfolder to its repository root", async () => {
    const parent = await repos.browseLocalRepositories(root);
    expect(parent.repository).toBeNull();
    expect(parent.entries.find(entry => entry.path === source)?.gitRepository).toBe(true);
    expect(parent.entries.some(entry => entry.path === join(root, "data"))).toBe(false);
    const child = await repos.browseLocalRepositories(join(source, "src"));
    expect(child.repository).toEqual({ path: source, branch: "main", commit: attached.commit });
  });
  it("explains missing folders and distinguishes repositories without an initial commit", async () => {
    await expect(repos.browseLocalRepositories(join(root, "missing"))).rejects.toThrow("could not be found");
    await expect(repos.browseLocalRepositories("relative/path")).rejects.toThrow("absolute folder path");
    const empty = join(root, "empty-repo"); mkdirSync(empty);
    execFileSync("git", ["-C", empty, "init", "-b", "main"], { stdio: "pipe" });
    expect((await repos.browseLocalRepositories(empty)).repository).toEqual({ path: empty, branch: "main", commit: null });
  });
  it("records commit and source and exposes complete paginated paths, including hidden configuration", async () => {
    expect(attached.commit).toBe(git("rev-parse", "HEAD"));
    expect(attached.localChangesExcluded).toBe(true);
    const page = await repos.queryRepository(id, { action: "files", repositoryId: attached.id, commit: attached.commit, limit: 2 }) as any;
    expect(page.total).toBe(8);
    expect(page.files[0].path).toBe(".hidden-config");
    expect(page.nextOffset).toBe(2);
    const rest = await repos.queryRepository(id, { action: "files", repositoryId: attached.id, commit: attached.commit, offset: 2 }) as any;
    expect(rest.files).toHaveLength(6); expect(rest.nextOffset).toBeNull();
  });
  it("searches the entire snapshot with exact source line numbers and case-insensitive literals", async () => {
    const result = await repos.queryRepository(id, { action: "search", repositoryId: attached.id, commit: attached.commit, query: "MEAN", limit: 1 }) as any;
    expect(result.total).toBe(2); expect(result.nextOffset).toBe(1);
    const next = await repos.queryRepository(id, { action: "search", repositoryId: attached.id, commit: attached.commit, query: "MEAN", offset: 1 }) as any;
    expect(next.matches).toEqual([{ path: "src/loss.py", line: 2, text: "    return x.mean()", truncated: false }]);
    const absent = await repos.queryRepository(id, { action: "search", repositoryId: attached.id, commit: attached.commit, query: "no_such_symbol" }) as any;
    expect(absent.total).toBe(0);
    expect(absent.coverage).toContain("not evidence of support");
  });
  it("returns stable blob identity, exact lines and recoverable pagination", async () => {
    const first = await read("src/loss.py", { endLine: 1 });
    const second = await read("src/loss.py", { startLine: first.nextLine });
    expect(first.content).toBe("def loss(x):"); expect(second.content).toBe("    return x.mean()");
    expect(first.oid).toBe(git("rev-parse", "HEAD:src/loss.py")); expect(second.nextLine).toBeNull();
    expect((await read("empty.txt")).content).toBe("");
  });
  it("excludes uncommitted changes from the snapshot", async () => {
    writeFileSync(join(source, "src/loss.py"), "LOCAL SECRET CHANGE\n");
    expect((await read("src/loss.py")).content).toBe(original.trimEnd());
    writeFileSync(join(source, "src/loss.py"), original);
  });
  it("requires an attached commit and project ownership", async () => {
    await expect(repos.queryRepository(id, { action: "files", repositoryId: attached.id })).rejects.toThrow("full recorded commit");
    await expect(repos.readRepositoryFile(id, { repositoryId: attached.id, commit: "a".repeat(40), path: "src/loss.py" })).rejects.toThrow("not an attached snapshot");
    const other = config.addProject({ name: "Other", gitUrl: "local" });
    await expect(repos.queryRepository(other.id, { action: "files", repositoryId: attached.id, commit: attached.commit })).rejects.toThrow("not attached");
  });
  it.each(["../config.json", "/etc/passwd", "src/../config.json"])("rejects traversal path %s", async path => {
    await expect(read(path)).rejects.toThrow("repository-relative");
  });
  it("does not follow symlinks, decode binaries, fetch LFS payloads, or silently truncate large files", async () => {
    await expect(read("outside")).rejects.toThrow("symlink");
    await expect(read("data.bin")).rejects.toThrow("Binary");
    await expect(read("model.bin")).rejects.toThrow("LFS pointer");
    await expect(read("large.txt")).rejects.toThrow("2 MiB");
    await expect(read("missing.py")).rejects.toThrow("not found");
  });
  it("validates line bounds", async () => {
    await expect(read("src/loss.py", { startLine: 3 })).rejects.toThrow("past the end");
    await expect(read("src/loss.py", { startLine: 2, endLine: 1 })).rejects.toThrow("precedes");
  });
  it.each(["ext::sh -c evil", "http://example.com/repo", "https://user:token@example.com/repo", "https://example.com/repo?token=secret", "-oProxyCommand=evil"])("rejects unsafe or credential-bearing source %s", source => {
    expect(() => repos.validateRepositorySource(source)).toThrow();
  });
  it("accepts SSH and HTTPS sources and slash-containing branch names", async () => {
    expect(repos.validateRepositorySource("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
    expect(repos.validateRepositorySource("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
    const branch = await repos.attachRepository(id, { source, ref: "feature/mean" });
    expect(branch.commit).toBe(attached.commit);
    await repos.removeRepository(id, branch.id);
  });
  it("rejects revision injection and leaves failed attachments out of the registry", async () => {
    const count = repos.listRepositories(id).length;
    await expect(repos.attachRepository(id, { source, ref: "--upload-pack=evil" })).rejects.toThrow("revision");
    await expect(repos.attachRepository(id, { source, ref: "missing-branch" })).rejects.toThrow("fetch failed");
    expect(repos.listRepositories(id)).toHaveLength(count);
  });
});

describe("claim evidence integrity", () => {
  it("validates real quotations and persists commit/blob identities and manuscript line/hash", async () => {
    const result = await evidence.verifyCodeClaim(id, dir, claim(), async prompt => {
      expect(prompt).toContain(attached.commit); expect(prompt).toContain("active configuration");
      return judgment();
    });
    expect(result.verdict).toBe("supported"); expect(result.evidence[0].line).toBe(2);
    expect(result.inputs[0].oid).toBe(git("rev-parse", "HEAD:src/loss.py"));
    expect(result.assessor.protocol).toBe("code-claim-v1");
    expect(evidence.codeAssessments(id, dir)[0].stale).toBe(false);
  });
  it("refuses invented or ambiguous manuscript passages before using the model", async () => {
    const call = vi.fn();
    await expect(evidence.verifyCodeClaim(id, dir, claim({ quote: "This claim is not in the manuscript." }), call)).rejects.toThrow("verbatim");
    writeFileSync(join(dir, "main.tex"), `${quote}\n${quote}`);
    await expect(evidence.verifyCodeClaim(id, dir, claim(), call)).rejects.toThrow("more than once");
    writeFileSync(join(dir, "main.tex"), quote);
    expect(call).not.toHaveBeenCalled();
  });
  it.each([{ quotes: [] }, { quotes: [{ index: 0, quote: "return x.sum()" }] }, { quotes: [{ index: 5, quote: "return x.mean()" }] }])("downgrades conclusions without locatable evidence: %j", async ({ quotes }) => {
    const result = await evidence.verifyCodeClaim(id, dir, claim(), async () => judgment({ evidence: quotes }));
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.limitations.join(" ")).toContain("downgraded");
  });
  it.each(["empirical", "theoretical"])("does not certify %s claims from static code", async claimKind => {
    const result = await evidence.verifyCodeClaim(id, dir, claim({ claimKind }), async () => judgment({ claimKind }));
    expect(result.verdict).toBe(claimKind === "empirical" ? "requires_execution" : "insufficient_evidence");
  });
  it("independently honors the assessor's classification when the caller mislabeled an empirical claim", async () => {
    const result = await evidence.verifyCodeClaim(id, dir, claim(), async () => judgment({ claimKind: "empirical" }));
    expect(result.verdict).toBe("requires_execution");
  });
  it("marks manuscript edits stale and rejects edits racing the model call", async () => {
    const before = evidence.codeAssessments(id, dir).length;
    await expect(evidence.verifyCodeClaim(id, dir, claim(), async () => {
      writeFileSync(join(dir, "main.tex"), quote + " Changed conditions."); return judgment();
    })).rejects.toThrow("changed during");
    expect(evidence.codeAssessments(id, dir)).toHaveLength(before);
    expect(evidence.codeAssessments(id, dir).every(a => a.stale)).toBe(true);
    writeFileSync(join(dir, "main.tex"), quote);
  });
  it("refreshes explicitly, keeps old snapshots readable and invalidates old assessments", async () => {
    writeFileSync(join(source, "src/loss.py"), "def loss(x):\n    return x.sum()\n");
    git("add", "."); git("commit", "-m", "Sum reduction");
    expect(repos.getRepository(id, attached.id).commit).toBe(attached.commit);
    const refreshed = await repos.refreshRepository(id, attached.id);
    expect(refreshed.commit).not.toBe(attached.commit);
    expect((await read("src/loss.py")).content).toContain("mean");
    expect(evidence.codeAssessments(id, dir).every(a => a.stale)).toBe(true);
    await expect(evidence.verifyCodeClaim(id, dir, claim(), vi.fn())).rejects.toThrow("snapshot changed");
    const result = await evidence.verifyCodeClaim(id, dir, claim({ evidence: [{ repositoryId: attached.id, commit: refreshed.commit, path: "src/loss.py", role: "counterevidence" }] }), async () => judgment({ verdict: "contradicted", evidence: [{ index: 0, quote: "return x.sum()" }] }));
    expect(result.verdict).toBe("contradicted");
    expect(evidence.codeAssessments(id, dir).some(a => !a.stale)).toBe(true);
  });
  it("cancellation cannot persist a late model assessment", async () => {
    const store = await import("../src/research/store.js");
    const controller = new AbortController();
    const repo = repos.getRepository(id, attached.id);
    const count = evidence.codeAssessments(id, dir).length;
    await expect(store.withResearchOperation(controller.signal, () => evidence.verifyCodeClaim(id, dir, claim({ evidence: [{ repositoryId: attached.id, commit: repo.commit, path: "src/loss.py", role: "implementation" }] }), async () => { controller.abort(); return judgment(); }))).rejects.toThrow();
    expect(evidence.codeAssessments(id, dir)).toHaveLength(count);
  });
  it("exposes repository tools to both dynamic and read-only catalogs and puts versions in the prompt", async () => {
    const { toolDefinitions } = await import("../src/backends/openai.js");
    const { codexTools } = await import("../src/backends/codex.js");
    for (const name of ["inspect_repository", "verify_code_claim", "list_code_evidence"]) {
      expect(toolDefinitions(true).some(t => t.function.name === name)).toBe(true);
      expect(codexTools().some(t => t.name === name)).toBe(true);
    }
    expect(repos.repositoryManifest(id)).toContain(repos.getRepository(id, attached.id).commit);
    // Git storage is not directly readable by native file tools, even when explicitly linked.
    const { resolveReadPath } = await import("../src/backends/paths.js");
    const storage = repos.repositoriesDir(id);
    expect(() => resolveReadPath(dir, [storage], join(storage, attached.id, "config"))).toThrow("private application data");
    expect(readFileSync(join(storage, attached.id, "config"), "utf8")).not.toContain("source");
  });
});
