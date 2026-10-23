import { describe, expect, it } from "vitest";
import { mergeText } from "../src/merge.js";

const b = (s: string) => Buffer.from(s);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe("mergeText (git merge-file)", () => {
  it("combines edits to different lines", async () => {
    const base = lines(40);
    const ours = [...base];
    ours[35] = "ours edited line 36";
    const theirs = [...base];
    theirs[2] = "theirs edited line 3";
    const r = await mergeText(b(base.join("\n") + "\n"), b(ours.join("\n") + "\n"), b(theirs.join("\n") + "\n"));
    expect(r?.conflicts).toBe(0);
    const text = r!.content.toString();
    expect(text).toContain("ours edited line 36");
    expect(text).toContain("theirs edited line 3");
  });

  it("counts a conflict when both sides change the same line differently", async () => {
    const r = await mergeText(b("a\nb\nc\n"), b("a\nB1\nc\n"), b("a\nB2\nc\n"), { ours: "yours", theirs: "Overleaf" });
    expect(r?.conflicts).toBe(1);
    expect(r!.content.toString()).toContain("<<<<<<< yours");
    expect(r!.content.toString()).toContain(">>>>>>> Overleaf");
  });

  it("takes one side when the other is unchanged, and identical edits once", async () => {
    expect((await mergeText(b("x\n"), b("x\n"), b("y\n")))?.content.toString()).toBe("y\n");
    expect((await mergeText(b("x\n"), b("y\n"), b("x\n")))?.content.toString()).toBe("y\n");
    const same = await mergeText(b("a\nb\n"), b("a\nc\n"), b("a\nc\n"));
    expect(same).toEqual({ content: b("a\nc\n"), conflicts: 0 });
  });

  it("refuses binary content", async () => {
    expect(await mergeText(b("a\0b"), b("a\0c"), b("a\0d"))).toBeNull();
  });

  it("merges against an empty base (file added on both sides)", async () => {
    const r = await mergeText(b(""), b("same\n"), b("other\n"));
    expect(r?.conflicts).toBe(1);
  });
});
