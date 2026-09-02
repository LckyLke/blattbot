import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // The read-only modes are explicitly accepted as defaults.
    expect(validateProjectSettingsPatch({ defaultMode: "review" })).toEqual({ defaultMode: "review" });
    expect(validateProjectSettingsPatch({ defaultMode: "understand" })).toEqual({
      defaultMode: "understand",
    });
    expect(() => validateProjectSettingsPatch({ defaultMode: "yolo" })).toThrow(/defaultMode/);
    expect(() => validateProjectSettingsPatch({ defaultMode: "Edit" })).toThrow(/defaultMode/);
  });
});

describe("AGENT_MODES catalog", () => {
  it("marks exactly review and understand as read-only (the flag both backends gate on)", () => {
    // The Claude backend adds Edit/Write/MultiEdit/NotebookEdit/add_citation to
    // disallowedTools and the openai backend drops its editing tools whenever
    // ctx.readOnly — which runTurn sets from this flag — is true.
    expect(AGENT_MODES.filter((m) => m.readOnly).map((m) => m.id)).toEqual([
      "review",
      "understand",
    ]);
  });

  it("understand mode explains instead of editing and points at Edit mode for changes", () => {
    const understand = AGENT_MODES.find((m) => m.id === "understand")!;
    expect(understand.label).toBe("Understand");
    expect(understand.prompt).toContain("must not modify any files");
    expect(understand.prompt).toContain("quote the relevant passage");
    expect(understand.prompt).toContain("AskUserQuestion");
    expect(understand.prompt).toContain("switch to Edit mode");
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

  it("describes each attached context path and asks the agent to check the text against it", () => {
    const root = mkdtempSync(join(tmpdir(), "blattbot-ctxprompt-test-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "train.py"), "lr = 3e-4\n");
      const out = buildSystemAppend(proj(), editMode, undefined, { ...DEFAULT_SETTINGS }, [root]);

      // The listing, not just the path — a bare path tells the agent nothing
      // about whether grepping the codebase is worth a tool call.
      expect(out).toContain(`${root} — 1 file (.py ×1)`);
      expect(out).toContain("src/train.py");
      expect(out).toMatch(/verify it against the source/);
      expect(out).toMatch(/never silently rewrite the text to match the code/);
      expect(out).toContain("NEVER create, modify, or delete anything inside them");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
