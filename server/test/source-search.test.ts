/**
 * Find in source (web/src/source-search.ts): LaTeX wraps prose over several
 * lines, so a typed space must also match a line break in the .tex file.
 */
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { sourceSearchQuery } from "../../web/src/source-search.js";

const matches = (doc: string, query: ReturnType<typeof sourceSearchQuery>) => {
  const hits: string[] = [];
  if (!query.valid) return hits;
  const cursor = query.getCursor(EditorState.create({ doc }));
  for (let item = cursor.next(); !item.done; item = cursor.next())
    hits.push(doc.slice(item.value.from, item.value.to));
  return hits;
};

describe("sourceSearchQuery", () => {
  it("matches a phrase that the source breaks over two lines", () => {
    const query = sourceSearchQuery({ search: "figure caption" });
    expect(matches("a figure\ncaption here", query)).toEqual(["figure\ncaption"]);
  });

  it("matches over a line break with indentation", () => {
    const query = sourceSearchQuery({ search: "the pipeline" });
    expect(matches("we ran the\n    pipeline twice", query)).toEqual(["the\n    pipeline"]);
  });

  it("still matches a plain space on one line", () => {
    const query = sourceSearchQuery({ search: "the pipeline" });
    expect(matches("we ran the pipeline twice", query)).toEqual(["the pipeline"]);
  });

  it("keeps regular-expression characters literal", () => {
    const query = sourceSearchQuery({ search: "\\cite{x} shows" });
    expect(matches("see \\cite{x}\nshows that", query)).toEqual(["\\cite{x}\nshows"]);
    expect(matches("see citeAx shows that", query)).toEqual([]);
  });

  it("does not turn a query without whitespace into a pattern", () => {
    const query = sourceSearchQuery({ search: "a.c" });
    expect(query.regexp).toBe(false);
    expect(matches("abc a.c", query)).toEqual(["a.c"]);
  });

  it("leaves a regular-expression search exactly as typed", () => {
    const query = sourceSearchQuery({ search: "a b", regexp: true });
    expect(matches("a\nb", query)).toEqual([]);
    expect(matches("a b", query)).toEqual(["a b"]);
  });

  it("honors case sensitivity and whole words across a line break", () => {
    expect(matches("Two Words", sourceSearchQuery({ search: "two words" }))).toEqual(["Two Words"]);
    expect(
      matches("Two Words", sourceSearchQuery({ search: "two words", caseSensitive: true })),
    ).toEqual([]);
    expect(
      matches("two\nwordsmith", sourceSearchQuery({ search: "two words", wholeWord: true })),
    ).toEqual([]);
  });

  it("keeps a dollar sign in the replacement literal", () => {
    const query = sourceSearchQuery({ search: "a b", replace: "$5 and $&" });
    const replacement = (query as any).create().getReplacement({ from: 0, to: 3, match: ["a b"] });
    expect(replacement).toBe("$5 and $&");
  });
});
