/**
 * blattbot.md: which version the agent gets (only a confirmed one), where it
 * goes in the system prompt, and the chat notice while a change is unreviewed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let config: typeof import("../src/config.js");
let shared: typeof import("../src/shared-instructions.js");
let agent: typeof import("../src/agent.js");
let settings: typeof import("../src/settings.js");

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-shared-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
  config = await import("../src/config.js");
  shared = await import("../src/shared-instructions.js");
  agent = await import("../src/agent.js");
  settings = await import("../src/settings.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function project(style?: string) {
  const p = config.addProject({ name: "Shared", kind: "local", gitUrl: "local", ...(style ? { settings: { styleAppend: style } } : {}) });
  mkdirSync(config.projectDir(p.id), { recursive: true });
  return p;
}
const write = (id: string, text: string) => writeFileSync(join(config.projectDir(id), "blattbot.md"), text);
const prompt = (id: string) =>
  agent.buildSystemAppend(config.getProject(id)!, agent.AGENT_MODES[0], undefined, { ...settings.DEFAULT_SETTINGS }, []);
const LABEL = "Shared project instructions (from blattbot.md in the project, synced with co-authors";

describe("shared instructions", () => {
  it("uses the cap of the local project instructions", () => {
    expect(shared.MAX_SHARED_INSTRUCTIONS).toBe(agent.MAX_STYLE_APPEND);
  });

  it("adds only a confirmed version to the prompt, before the local instructions", () => {
    const p = project("Local rule.");
    write(p.id, "Shared rule v1.\n");
    expect(prompt(p.id)).not.toContain(LABEL);
    const first = shared.sharedInstructionsState(config.getProject(p.id)!);
    expect(shared.sharedInstructionsNotice(first)).toBe("blattbot.md is new — review it in Project settings. This turn runs without shared instructions.");

    shared.confirmSharedInstructions(p.id, first.sha256!);
    const out = prompt(p.id);
    expect(out).toContain(`${LABEL}; the user reviewed and confirmed this version):\nShared rule v1.`);
    expect(out.indexOf(LABEL)).toBeLessThan(out.indexOf("Project instructions (from this project's settings):\nLocal rule."));
    expect(shared.sharedInstructionsNotice(shared.sharedInstructionsState(config.getProject(p.id)!))).toBeNull();

    // Changed by a co-author: v1 stays in use, and each turn says so.
    write(p.id, "Shared rule v2.\n");
    const changed = shared.sharedInstructionsState(config.getProject(p.id)!);
    expect(changed).toMatchObject({ status: "unconfirmed", usingPrevious: true, active: "Shared rule v1." });
    expect(prompt(p.id)).toContain("Shared rule v1.");
    expect(prompt(p.id)).not.toContain("Shared rule v2.");
    expect(shared.sharedInstructionsNotice(changed)).toBe(
      "blattbot.md changed — review it in Project settings. This turn uses the version you confirmed earlier.",
    );

    // Removed: nothing is used.
    rmSync(join(config.projectDir(p.id), "blattbot.md"));
    expect(shared.sharedInstructionsState(config.getProject(p.id)!)).toMatchObject({ status: "none", active: null });
    expect(prompt(p.id)).not.toContain(LABEL);
  });

  it("caps long files and refuses a confirmation for a file that changed meanwhile", () => {
    const p = project();
    write(p.id, "x".repeat(5000));
    const state = shared.sharedInstructionsState(config.getProject(p.id)!);
    expect(state.truncated).toBe(true);
    write(p.id, "y".repeat(10));
    expect(() => shared.confirmSharedInstructions(p.id, state.sha256!)).toThrow(/changed while you were reviewing/);
    write(p.id, "x".repeat(5000));
    expect(shared.confirmSharedInstructions(p.id, state.sha256!).active).toHaveLength(shared.MAX_SHARED_INSTRUCTIONS);
  });

  it("ignores binary or empty files", () => {
    const p = project();
    writeFileSync(join(config.projectDir(p.id), "blattbot.md"), Buffer.from([0x41, 0, 0x42]));
    expect(shared.sharedInstructionsState(config.getProject(p.id)!)).toMatchObject({ status: "none", error: expect.stringMatching(/not a text file/) });
    write(p.id, "  \n");
    expect(shared.sharedInstructionsState(config.getProject(p.id)!)).toMatchObject({ status: "none", needsReview: false, active: null });
  });
});
