/**
 * Optional Overleaf history labels for pushes (Project settings → "Label each
 * push in Overleaf's history"): the approve flow flushes Overleaf's history,
 * labels the newest version, and never fails the push when that goes wrong.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOverleaf, type MockOverleaf } from "../scripts/mock-overleaf.js";
import { freePort } from "../scripts/free-port.js";
import { MAX_LABEL_LENGTH, pushLabelText } from "../src/overleaf/labels.js";
import type { Project, ProjectSettings } from "../src/config.js";

const REMOTE_ID = "aaaa1111bbbb2222cccc4444";
const COOKIE = "overleaf_session2=mock-session";
const MAIN = "\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n";

describe("pushLabelText", () => {
  it("uses the commit message's first line and marks it as BlattBot's", () => {
    expect(pushLabelText("Agent: tighten the intro\n\nBlattBot-Kind: approve")).toBe("Agent: tighten the intro (BlattBot)");
    expect(pushLabelText("   ")).toBe("BlattBot edit (BlattBot)");
  });

  it("shortens long messages to the label limit", () => {
    const label = pushLabelText("x".repeat(500));
    expect(label.length).toBe(MAX_LABEL_LENGTH);
    expect(label.endsWith("… (BlattBot)")).toBe(true);
  });
});

describe("labelling pushes in Overleaf's history", () => {
  let mock: MockOverleaf;
  let base = "";
  let dataDir: string;
  let dir: string;
  let sync: typeof import("../src/sync.js");
  let git: typeof import("../src/git.js");

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    mock = await startMockOverleaf(port, REMOTE_ID);
  });

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-labels-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.resetModules();
    const config = await import("../src/config.js");
    sync = await import("../src/sync.js");
    git = await import("../src/git.js");
    dir = config.projectDir("label-proj");
    mkdirSync(dir, { recursive: true });
    await git.initRepo(dir);
    mock.files.clear();
    mock.docVersions.clear();
    mock.historyApi = true;
    mock.reviewForbidden = false;
    mock.project.history = { version: 0, labels: [] };
    writeFileSync(join(dir, "main.tex"), MAIN);
    mock.files.set("main.tex", Buffer.from(MAIN));
    await git.commitAll(dir, "Initial sync from Overleaf");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const project = (settings: ProjectSettings = {}): Project => ({
    id: "label-proj",
    name: "Label Proj",
    gitUrl: `${base}/project/${REMOTE_ID}`,
    kind: "overleaf",
    overleafBaseUrl: base,
    overleafProjectId: REMOTE_ID,
    cookie: COOKIE,
    settings,
    createdAt: new Date().toISOString(),
  });

  it("labels the version that holds the push", async () => {
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Edited body."));
    const result = await sync.approve(project({ labelPushes: true }), "Agent: tighten the body");
    expect(result.pushed).toBe(true);
    expect(result.historyLabel).toBe("Agent: tighten the body (BlattBot)");
    expect(mock.files.get("main.tex")!.toString()).toContain("Edited body.");
    // The flush moved the push into history before the label was placed.
    expect(mock.project.history.version).toBe(1);
    expect(mock.project.history.labels).toEqual([
      expect.objectContaining({ comment: "Agent: tighten the body (BlattBot)", version: 1 }),
    ]);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("adds no label when the setting is off", async () => {
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Edited body."));
    const result = await sync.approve(project(), "Plain push");
    expect(result.pushed).toBe(true);
    expect(result.historyLabel).toBeUndefined();
    expect(mock.project.history.labels).toEqual([]);
    // Every push still reads the history version, so it does not read as a co-author's change.
    expect(result.remoteVersion).toBe(mock.project.history.version);
  });

  it("keeps the push and warns when the instance has no history API", async () => {
    mock.historyApi = false;
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Edited body."));
    const result = await sync.approve(project({ labelPushes: true }), "Agent: edit");
    expect(result.pushed).toBe(true);
    expect(result.historyLabel).toBeUndefined();
    expect(mock.files.get("main.tex")!.toString()).toContain("Edited body.");
    expect(result.warnings?.some((w) => /labelling it in Overleaf's history failed/.test(w) && /no project history API/.test(w))).toBe(true);
    // Nothing stays pending: the push itself landed.
    expect(await git.workingDiff(dir)).toBe("");
  });

  it("keeps the push and warns when Overleaf refuses the label", async () => {
    mock.reviewForbidden = true;
    writeFileSync(join(dir, "main.tex"), MAIN.replace("Body.", "Edited body."));
    const result = await sync.approve(project({ labelPushes: true }), "Agent: edit");
    expect(result.pushed).toBe(true);
    expect(mock.project.history.labels).toEqual([]);
    expect(result.warnings?.some((w) => /does not let this account add history labels/.test(w))).toBe(true);
  });
});

describe("project settings validation", () => {
  it("accepts labelPushes as a boolean only", async () => {
    const { validateProjectSettingsPatch } = await import("../src/agent.js");
    expect(validateProjectSettingsPatch({ labelPushes: true })).toEqual({ labelPushes: true });
    expect(() => validateProjectSettingsPatch({ labelPushes: "yes" })).toThrow("labelPushes must be true or false");
  });
});
