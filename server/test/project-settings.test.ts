import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MODES,
  MAX_STYLE_APPEND,
  SYSTEM_APPEND,
  buildSystemAppend,
  resolveProjectModel,
  validateProjectSettingsPatch,
} from "../src/agent.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { Project } from "../src/config.js";

const STYLE_LABEL = "Project instructions (from this project's settings):";

function proj(settings?: Project["settings"]): Project {
  return {
    id: "p-123456",
    name: "Test",
    gitUrl: "local",
    kind: "local",
    createdAt: new Date().toISOString(),
    ...(settings ? { settings } : {}),
  };
}

const editMode = AGENT_MODES[0];
const researchMode = AGENT_MODES.find((m) => m.id === "research")!;

describe("validateProjectSettingsPatch", () => {
  it("returns only the provided, recognized fields", () => {
    expect(validateProjectSettingsPatch({})).toEqual({});
    expect(validateProjectSettingsPatch(undefined)).toEqual({});
    expect(validateProjectSettingsPatch({ model: "fable", bogus: "x" })).toEqual({ model: "fable" });
    expect(
      validateProjectSettingsPatch({ styleAppend: "Use British English.", defaultMode: "review" }),
    ).toEqual({ styleAppend: "Use British English.", defaultMode: "review" });
  });

  it("accepts empty strings (they clear the field)", () => {
    expect(validateProjectSettingsPatch({ styleAppend: "", model: "", defaultMode: "" })).toEqual({
      styleAppend: "",
      model: "",
      defaultMode: "",
    });
  });

  it("rejects non-string values", () => {
    expect(() => validateProjectSettingsPatch({ styleAppend: 42 })).toThrow(/must be a string/);
    expect(() => validateProjectSettingsPatch({ model: null })).toThrow(/must be a string/);
    expect(() => validateProjectSettingsPatch({ defaultMode: ["edit"] })).toThrow(/must be a string/);
  });

  it("caps styleAppend at MAX_STYLE_APPEND characters", () => {
    expect(validateProjectSettingsPatch({ styleAppend: "x".repeat(MAX_STYLE_APPEND) })).toEqual({
      styleAppend: "x".repeat(MAX_STYLE_APPEND),
    });
    expect(() =>
      validateProjectSettingsPatch({ styleAppend: "x".repeat(MAX_STYLE_APPEND + 1) }),
    ).toThrow(/too long/);
  });

  it("caps the model id length", () => {
    expect(() => validateProjectSettingsPatch({ model: "m".repeat(201) })).toThrow(/too long/);
  });

  it("allows only AGENT_MODES ids (or empty) as defaultMode", () => {
    for (const m of AGENT_MODES) {
      expect(validateProjectSettingsPatch({ defaultMode: m.id })).toEqual({ defaultMode: m.id });
    }
    expect(() => validateProjectSettingsPatch({ defaultMode: "yolo" })).toThrow(/defaultMode/);
    expect(() => validateProjectSettingsPatch({ defaultMode: "Edit" })).toThrow(/defaultMode/);
  });
});

describe("buildSystemAppend", () => {
  it("is just the base append for a plain edit turn", () => {
    expect(buildSystemAppend(proj(), editMode, undefined, { ...DEFAULT_SETTINGS }, [])).toBe(
      SYSTEM_APPEND,
    );
  });

  it("places the labelled styleAppend after the mode block and before the global append", () => {
    const out = buildSystemAppend(
      proj({ styleAppend: "Use British English. Prefer \\autoref." }),
      researchMode,
      ["main.tex"],
      { ...DEFAULT_SETTINGS, systemPromptAppend: "Global extra rule." },
      [],
    );
    const iMode = out.indexOf(researchMode.prompt);
    const iLabel = out.indexOf(STYLE_LABEL);
    const iStyle = out.indexOf("Use British English. Prefer \\autoref.");
    const iScope = out.indexOf("only EDIT these files: main.tex");
    const iGlobal = out.indexOf("Additional instructions from the user's BlattBot settings:");
    expect(iMode).toBeGreaterThan(-1);
    expect(iLabel).toBeGreaterThan(iMode + researchMode.prompt.length - 1);
    expect(iStyle).toBeGreaterThan(iLabel);
    expect(iScope).toBeGreaterThan(iStyle);
    expect(iGlobal).toBeGreaterThan(iScope);
    expect(out.indexOf("Global extra rule.")).toBeGreaterThan(iGlobal);
  });

  it("omits the style block when styleAppend is empty or whitespace", () => {
    for (const styleAppend of [undefined, "", "   \n "]) {
      const out = buildSystemAppend(
        proj(styleAppend === undefined ? undefined : { styleAppend }),
        editMode,
        undefined,
        { ...DEFAULT_SETTINGS },
        [],
      );
      expect(out).not.toContain(STYLE_LABEL);
    }
  });

  it("re-caps an over-long styleAppend (hand-edited projects.json)", () => {
    const out = buildSystemAppend(
      proj({ styleAppend: "y".repeat(MAX_STYLE_APPEND) + "OVERFLOW" }),
      editMode,
      undefined,
      { ...DEFAULT_SETTINGS },
      [],
    );
    expect(out).toContain(STYLE_LABEL);
    expect(out).not.toContain("OVERFLOW");
  });
});

describe("resolveProjectModel", () => {
  it("prefers the project override and resolves aliases", () => {
    expect(resolveProjectModel(proj({ model: "fable" }), "claude-opus-5")).toBe("claude-fable-5");
    expect(resolveProjectModel(proj({ model: "claude-opus-4-6" }), "sonnet")).toBe("claude-opus-4-6");
  });

  it("falls back to the global setting when no override is set", () => {
    expect(resolveProjectModel(proj(), "opus")).toBe("claude-opus-5");
    expect(resolveProjectModel(proj({ model: "" }), "opus")).toBe("claude-opus-5");
    expect(resolveProjectModel(proj({ model: "   " }), "opus")).toBe("claude-opus-5");
  });

  it("lands on the BlattBot default when neither is set", () => {
    expect(resolveProjectModel(proj(), "")).toBe("claude-sonnet-5");
  });
});

describe("project settings persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blattbot-projsettings-test-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", dir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the whole settings object and replaces it wholesale on update", async () => {
    const config = await import("../src/config.js");
    const p = config.addProject({ name: "Paper", gitUrl: "local", kind: "local" });

    config.updateProject(p.id, { settings: { styleAppend: "Be terse.", model: "fable" } });
    expect(config.getProject(p.id)?.settings).toEqual({ styleAppend: "Be terse.", model: "fable" });

    // updateProject shallow-merges top-level keys — a new settings object
    // replaces the old one entirely (the endpoint merges before writing).
    config.updateProject(p.id, { settings: { defaultMode: "research" } });
    expect(config.getProject(p.id)?.settings).toEqual({ defaultMode: "research" });

    // The public view keeps the settings (they are not a secret).
    expect(config.publicProject(config.getProject(p.id)!).settings).toEqual({
      defaultMode: "research",
    });
  });
});
