import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";
import { OverleafClient } from "../src/overleaf/olclient.js";
import { publishTree } from "../src/sync.js";
import * as git from "../src/git.js";

const PORT = 4655;
const PRIMARY_ID = "0123456789abcdef01234567";
const COOKIE = "overleaf_session2=mock-session";

describe("publishTree (local → Overleaf)", () => {
  let mock: MockOverleaf;
  let dir: string;

  beforeAll(async () => {
    mock = await startMockOverleaf(PORT, PRIMARY_ID);
    dir = mkdtempSync(join(tmpdir(), "blattbot-publish-"));
    await git.initRepo(dir);
    writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\\begin{document}Local body.\\end{document}\n");
    writeFileSync(join(dir, "references.bib"), "% empty bibliography\n");
    mkdirSync(join(dir, "sections"), { recursive: true });
    writeFileSync(join(dir, "sections/intro.tex"), "\\section{Intro}\n");
    await git.commitAll(dir, "New project");
  });

  afterAll(async () => {
    await mock.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("creates a remote project, wipes the template, and uploads the full tree", async () => {
    const client = new OverleafClient(`http://127.0.0.1:${PORT}`, COOKIE);
    const result = await publishTree(client, "My Local Paper", dir);

    // A fresh remote project was created with the requested name.
    expect(mock.created).toHaveLength(1);
    const remote = mock.created[0];
    expect(remote.name).toBe("My Local Paper");
    expect(result.remoteProjectId).toBe(remote.id);
    expect(result.remoteProjectId).toMatch(/^[0-9a-f]{24}$/);

    // Template entities were deleted before the push.
    expect(remote.deletes).toEqual(expect.arrayContaining(["main.tex", "sample.bib"]));
    expect(remote.files.has("sample.bib")).toBe(false);

    // Every local file landed remotely, including the subfolder one.
    expect(result.uploaded.sort()).toEqual(["main.tex", "references.bib", "sections/intro.tex"]);
    expect(result.warnings).toEqual([]);
    expect(remote.files.get("main.tex")?.toString()).toContain("Local body.");
    expect(remote.files.get("sections/intro.tex")?.toString()).toContain("\\section{Intro}");

    // The primary mock project was untouched.
    expect(mock.files.size).toBe(0);
  });

  it("requires a working session", async () => {
    mock.authOk = false;
    const client = new OverleafClient(`http://127.0.0.1:${PORT}`, COOKIE);
    await expect(publishTree(client, "Nope", dir)).rejects.toThrow(/session|cookie/i);
    mock.authOk = true;
  });
});
