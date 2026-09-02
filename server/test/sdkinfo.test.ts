/** Engine/SDK discovery for doctor and the transparency tab (server/src/sdkinfo.ts). */
import { describe, expect, it } from "vitest";
import { agentSdkVersion, bundledExecutable, describeEngine, executableOptions } from "../src/sdkinfo.js";

describe("sdkinfo", () => {
  it("reads the installed SDK's version (its exports map hides package.json)", () => {
    expect(agentSdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("passes the executable override through, and nothing without it", () => {
    expect(executableOptions({})).toEqual({});
    expect(executableOptions({ BLATTBOT_CLAUDE_EXECUTABLE: "  " })).toEqual({});
    expect(executableOptions({ BLATTBOT_CLAUDE_EXECUTABLE: "/opt/claude" })).toEqual({
      pathToClaudeCodeExecutable: "/opt/claude",
    });
  });

  it("describes the engine: an override (flagging a missing file) or the bundled binary", () => {
    expect(describeEngine({ BLATTBOT_CLAUDE_EXECUTABLE: "/nowhere/claude" })).toBe(
      "/nowhere/claude (BLATTBOT_CLAUDE_EXECUTABLE) — NOT FOUND",
    );
    const bundled = bundledExecutable();
    const line = describeEngine({});
    if (bundled) expect(line).toBe(`bundled with the Agent SDK (${bundled})`);
    else expect(line).toContain("no bundled binary");
  });
});
