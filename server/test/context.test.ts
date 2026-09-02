import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-context-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function load() {
  const config = await import("../src/config.js");
  const context = await import("../src/context.js");
  return { config, context };
}

describe("sanitizeUploadName", () => {
  it("flattens paths and rejects hostile names", async () => {
    const { context } = await load();
    expect(context.sanitizeUploadName("paper.pdf")).toBe("paper.pdf");
    expect(context.sanitizeUploadName("/tmp/evil/../paper.pdf")).toBe("paper.pdf");
    expect(context.sanitizeUploadName("C:\\docs\\notes.md")).toBe("notes.md");
    expect(() => context.sanitizeUploadName("..")).toThrow();
    expect(() => context.sanitizeUploadName(".hidden")).toThrow();
    expect(() => context.sanitizeUploadName("   ")).toThrow();
  });
});

describe("uploads + links", () => {
  it("stores, lists, serves-path, and deletes uploads per project", async () => {
    const { context } = await load();
    context.saveUpload("proj1", "results.csv", Buffer.from("a,b\n1,2\n"));
    context.saveUpload("proj1", "notes.md", Buffer.from("# notes"));
    const fake = { id: "proj1", name: "x", gitUrl: "", createdAt: "" } as any;
    const listed = context.listContext(fake);
    expect(listed.uploads.map((u) => u.name)).toEqual(["notes.md", "results.csv"]);
    expect(context.uploadPath("proj1", "results.csv")).toContain(join("context", "proj1"));
    expect(context.deleteUpload("proj1", "notes.md")).toBe(true);
    expect(context.deleteUpload("proj1", "notes.md")).toBe(false);
    expect(context.listContext(fake).uploads).toHaveLength(1);
  });

  it("rejects oversized uploads", async () => {
    const { context } = await load();
    const big = Buffer.alloc(context.MAX_UPLOAD_BYTES + 1);
    expect(() => context.saveUpload("proj1", "big.bin", big)).toThrow(/too large/);
  });

  it("validates link paths: must exist, must not be the mirror", async () => {
    const { config, context } = await load();
    const p = config.addProject({ name: "T", gitUrl: "", kind: "local" });
    mkdirSync(config.projectDir(p.id), { recursive: true });
    writeFileSync(join(config.projectDir(p.id), "main.tex"), "x");
    const external = join(dir, "external-code");
    mkdirSync(external);

    expect(context.validateLinkPath(p, external)).toBe(external);
    expect(() => context.validateLinkPath(p, join(dir, "nope"))).toThrow(/does not exist/);
    expect(() => context.validateLinkPath(p, config.projectDir(p.id))).toThrow(/inside the project/);
    expect(() => context.validateLinkPath(p, join(config.projectDir(p.id), "main.tex"))).toThrow(
      /inside the project/,
    );
  });

  it("contextDirectories returns only existing links plus the uploads dir", async () => {
    const { config, context } = await load();
    const p = config.addProject({ name: "T", gitUrl: "", kind: "local" });
    const external = join(dir, "data");
    mkdirSync(external);
    writeFileSync(join(external, "r.csv"), "x");
    config.updateProject(p.id, { contextPaths: [external, join(dir, "gone")] });
    context.saveUpload(p.id, "paper.pdf", Buffer.from("%PDF-1.4"));
    const dirs = context.contextDirectories(config.getProject(p.id)!);
    expect(dirs).toContain(external);
    expect(dirs).toContain(context.contextUploadsDir(p.id));
    expect(dirs).not.toContain(join(dir, "gone"));
  });
});

/** A miniature codebase: source, tests, a vendored dependency, a build output. */
function makeRepo(root: string): string {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "node_modules", "lodash"), { recursive: true });
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# repo");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "src", "model.py"), "def loss(): ...");
  writeFileSync(join(root, "src", "train.py"), "lr = 3e-4");
  writeFileSync(join(root, "tests", "test_model.py"), "assert True");
  writeFileSync(join(root, "node_modules", "lodash", "index.js"), "module.exports = {}");
  writeFileSync(join(root, ".git", "objects", "abc"), "blob");
  writeFileSync(join(root, "dist", "bundle.js"), "()=>{}");
  return root;
}

describe("scanContextDir", () => {
  it("maps a codebase: relative paths, extension counts, vendored dirs left out", async () => {
    const { context } = await load();
    const m = context.scanContextDir(makeRepo(join(dir, "repo")));

    expect(m.kind).toBe("dir");
    expect(m.entries).toEqual(["README.md", "src/model.py", "src/train.py", "tests/test_model.py"]);
    expect(m.fileCount).toBe(4);
    expect(m.truncated).toBe(false);
    expect(m.extensions).toEqual([
      { ext: ".py", count: 3 },
      { ext: ".md", count: 1 },
    ]);
    // Named, not silently dropped — the agent can still Grep them.
    expect(m.skipped).toEqual([".git", "dist", "node_modules"]);
  });

  it("caps the listing and names the subtrees it did not expand", async () => {
    const { context } = await load();
    const root = join(dir, "big");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(root, "a", `f${i}.py`), "x");
    for (let i = 0; i < 5; i++) writeFileSync(join(root, "b", `g${i}.py`), "x");

    const m = context.scanContextDir(root, 5);
    expect(m.truncated).toBe(true);
    // a/ filled the file budget; b/ is still reported, as an unexpanded
    // subtree — the cap costs detail, never a whole branch's existence.
    expect(m.entries.filter((e) => !e.endsWith("…"))).toHaveLength(5);
    expect(m.entries).toContain("b/…");
    // Files past the cap still count toward the totals the header reports.
    expect(m.fileCount).toBe(5);
  });

  it("summarizes subtrees deeper than the depth limit", async () => {
    const { context } = await load();
    const root = join(dir, "deep");
    mkdirSync(join(root, "one", "two", "three"), { recursive: true });
    writeFileSync(join(root, "one", "two", "three", "buried.py"), "x");

    // Depth 2 expands one/ and one/two/; what lies below is summarized.
    const m = context.scanContextDir(root, 50, 2);
    expect(m.entries).toEqual(["one/two/three/…"]);
    expect(m.truncated).toBe(true);
  });

  it("handles a linked single file and a path that has gone away", async () => {
    const { context } = await load();
    const file = join(dir, "notes.md");
    writeFileSync(file, "# notes");
    expect(context.scanContextDir(file).kind).toBe("file");
    expect(context.scanContextDir(join(dir, "nope")).kind).toBe("missing");
  });

  it("does not follow symlinked directories — a cycle must not hang the walk", async () => {
    const { context } = await load();
    const root = join(dir, "linky");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.py"), "x");
    try {
      symlinkSync(root, join(root, "self"), "dir");
    } catch {
      return; // Windows without developer mode — nothing to assert
    }
    const m = context.scanContextDir(root);
    expect(m.entries).toEqual(["a.py"]);
  });
});

describe("formatContextManifest", () => {
  it("renders a header, the listing, and what was left out", async () => {
    const { context } = await load();
    const out = context.formatContextManifest([makeRepo(join(dir, "repo"))]);

    expect(out).toContain(`${join(dir, "repo")} — 4 files (.py ×3, .md ×1)`);
    expect(out).toContain("    src/train.py");
    expect(out).toContain("not listed: .git, dist, node_modules");
    expect(out).not.toContain("bundle.js");
  });

  it("is empty without attached context and splits its budget across paths", async () => {
    const { context } = await load();
    expect(context.formatContextManifest([])).toBe("");

    // Ten linked repos must not produce ten full listings.
    const roots = [];
    for (let i = 0; i < 10; i++) {
      const root = join(dir, `r${i}`);
      mkdirSync(root, { recursive: true });
      for (let f = 0; f < 40; f++) writeFileSync(join(root, `f${f}.py`), "x");
      roots.push(root);
    }
    const lines = context.formatContextManifest(roots).split("\n");
    const listed = lines.filter((l) => l.startsWith("    f")).length;
    expect(listed).toBeLessThanOrEqual(context.MANIFEST_MAX_ENTRIES);
    expect(lines.filter((l) => l.includes("listing shortened"))).toHaveLength(10);
  });

  it("reports a link whose target disappeared instead of pretending it is empty", async () => {
    const { context } = await load();
    expect(context.formatContextManifest([join(dir, "gone")])).toContain("no longer exists");
  });
});

describe("browseDirectories", () => {
  it("lists subdirectories only, sorted, with their absolute paths", async () => {
    const { context } = await load();
    const root = join(dir, "browse");
    mkdirSync(join(root, "zeta"), { recursive: true });
    mkdirSync(join(root, "alpha"), { recursive: true });
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, "file.txt"), "x");

    const listing = context.browseDirectories(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(dir);
    expect(listing.entries).toEqual([
      { name: "alpha", path: join(root, "alpha") },
      { name: "zeta", path: join(root, "zeta") },
    ]);
    expect(listing.truncated).toBe(false);
  });

  it("defaults to the home directory and reports the filesystem root's missing parent", async () => {
    const { context } = await load();
    expect(context.browseDirectories()).toMatchObject({ path: homedir() });
    expect(context.browseDirectories(parse(homedir()).root).parent).toBeNull();
  });

  it("refuses to browse credential stores and BlattBot's own data", async () => {
    const { context } = await load();
    // DATA_DIR is the stubbed temp dir here; chats/ holds transcripts.
    const chats = join(dir, "chats");
    mkdirSync(join(chats, "inner"), { recursive: true });
    expect(() => context.browseDirectories(chats)).toThrow(/credentials or BlattBot's own data/);
    expect(context.browseDirectories(dir).entries.map((e) => e.name)).not.toContain("chats");
  });

  it("rejects a missing path and a file", async () => {
    const { context } = await load();
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    expect(() => context.browseDirectories(join(dir, "nope"))).toThrow(/no such folder/);
    expect(() => context.browseDirectories(file)).toThrow(/not a folder/);
  });
});
