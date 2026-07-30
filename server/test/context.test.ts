import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-context-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
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
