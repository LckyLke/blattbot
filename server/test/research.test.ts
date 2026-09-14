import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { textPdf } from "./fixtures/pdf.js";
let root: string, dir: string;
const bib =
  "@article{alpha, title={Graph Models}, author={Smith, Ada}, year={2020}, doi={10.1234/alpha}}\n@article{beta, title={Neural Optimization}, author={Jones, Bea}, year={2021}, doi={10.1234/beta}}";
const quote = "Accuracy was 91 percent on dataset A.";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blattbot-research-"));
  dir = join(root, "project");
  mkdirSync(dir);
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  writeFileSync(join(dir, "refs.bib"), bib);
  writeFileSync(
    join(dir, "main.tex"),
    "Accuracy was 91 percent~\\cite{alpha}.\n\nAnother result~\\cite{alpha,beta}.\n% \\cite{ghost}\n",
  );
  writeFileSync(
    join(dir, "alpha.pdf"),
    textPdf(["Graph Models. We study graphs.", quote]),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
const supported = async () =>
  JSON.stringify({
    verdict: "supported",
    explanation: "The source reports the stated measurement.",
    quotes: [{ page: 2, quote }],
  });

describe("versioned claim evidence", () => {
  it("tracks each claim/key pair and validates real PDF page quotations", async () => {
    const { manuscriptClaims, verifyClaim, evidenceView } = await import(
      "../src/research/evidence.js"
    );
    const claims = manuscriptClaims(dir);
    expect(claims.map((c) => c.key)).toEqual(["alpha", "alpha", "beta"]);
    const result = await verifyClaim("p1", dir, claims[0].id, supported);
    expect(result).toMatchObject({
      verdict: "supported",
      quotes: [{ page: 2, quote }],
      source: {
        basis: "full_text",
        fileHash: expect.any(String),
        textHash: expect.any(String),
      },
    });
    expect(evidenceView("p1", dir).map((e) => e.status)).toEqual([
      "supported",
      "unchecked",
      "unchecked",
    ]);
  });
  it("rejects fabricated quotations and incorrect page attribution", async () => {
    const { manuscriptClaims, verifyClaim } = await import(
      "../src/research/evidence.js"
    );
    const id = manuscriptClaims(dir)[0].id;
    for (const q of [
      { page: 2, quote: "A fabricated 99 percent result." },
      { page: 1, quote },
    ]) {
      const result = await verifyClaim("p1", dir, id, async () =>
        JSON.stringify({
          verdict: "supported",
          explanation: "Proposed",
          quotes: [q],
        }),
      );
      expect(result.verdict).toBe("unclear");
      expect(result.quotes).toEqual([]);
    }
  });
  it("invalidates edits to claims, bibliography and PDF bytes", async () => {
    const { manuscriptClaims, verifyClaim, evidenceView } = await import(
      "../src/research/evidence.js"
    );
    await verifyClaim("p1", dir, manuscriptClaims(dir)[0].id, supported);
    const original = readFileSync(join(dir, "main.tex"), "utf8");
    writeFileSync(join(dir, "main.tex"), original.replace("91", "97"));
    expect(evidenceView("p1", dir)[0].status).toBe("stale");
    writeFileSync(join(dir, "main.tex"), original);
    writeFileSync(join(dir, "refs.bib"), bib.replace("Ada", "Alice"));
    expect(evidenceView("p1", dir)[0].status).toBe("stale");
    writeFileSync(join(dir, "refs.bib"), bib);
    writeFileSync(
      join(dir, "alpha.pdf"),
      textPdf(["Graph Models. New revision.", quote]),
    );
    expect(evidenceView("p1", dir)[0].status).toBe("stale");
  });
  it("does not store a result when its source changes during the model call", async () => {
    const { manuscriptClaims, verifyClaim, evidenceView } = await import(
      "../src/research/evidence.js"
    );
    await expect(
      verifyClaim("p1", dir, manuscriptClaims(dir)[0].id, async () => {
        writeFileSync(
          join(dir, "alpha.pdf"),
          textPdf(["Graph Models. Changed."]),
        );
        return supported();
      }),
    ).rejects.toThrow(/changed/);
    expect(evidenceView("p1", dir)[0].status).toBe("unchecked");
  });
  it("reports missing sources without asking the model to guess", async () => {
    const { manuscriptClaims, verifyClaim } = await import(
      "../src/research/evidence.js"
    );
    const call = vi.fn();
    const result = await verifyClaim(
      "p1",
      dir,
      manuscriptClaims(dir)[2].id,
      call,
    );
    expect(result.verdict).toBe("unclear");
    expect(result.source.basis).toBe("none");
    expect(call).not.toHaveBeenCalled();
  });
  it("refuses ambiguous duplicate citation-key source bindings", async () => {
    writeFileSync(
      join(dir, "extra.bib"),
      "@article{alpha,title={A different paper}}",
    );
    const { getPaperContent } = await import("../src/papers.js");
    const result = await getPaperContent("p1", dir, "alpha");
    expect(result.basis).toBe("none");
    expect(result.limitations.join(" ")).toContain("Duplicate citation key");
  });
  it("selects later-page evidence in long papers and labels limited coverage", async () => {
    const { sourcePassages } = await import("../src/research/evidence.js");
    const result = sourcePassages(
      {
        key: "x",
        title: "X",
        basis: "full_text",
        pages: [
          "boilerplate ".repeat(15000),
          "Unique ablation goldfish finding",
        ],
        limitations: [],
      },
      "goldfish",
      3000,
    );
    expect(result.text).toContain("[Page 2]");
    expect(result.limited).toBe(true);
  });
});

describe("reviewed literature workflow", () => {
  async function analyze() {
    const m = await import("../src/research/matrix.js");
    const fields = Object.fromEntries(
      m.matrixFields.map((f) => [
        f,
        { text: `Extracted ${f}`, quotes: [{ page: 2, quote }] },
      ]),
    );
    return {
      m,
      row: await m.analyzePaper("p1", dir, "alpha", async () =>
        JSON.stringify(fields),
      ),
    };
  }
  it("requires human-reviewed rows and outline approval before writing", async () => {
    const { m, row } = await analyze();
    await expect(
      m.buildOutline("p1", dir, async () => "Outline"),
    ).rejects.toThrow(/Review every/);
    expect(() => m.relatedWritingPrompt("p1", dir)).toThrow(/Approve/);
    m.reviewMatrixRow(
      "p1",
      dir,
      "alpha",
      "Comparable within dataset A only.",
      true,
      row.at,
    );
    const outline = await m.buildOutline(
      "p1",
      dir,
      async () => "## Baselines\nCompare alpha, preserve dataset qualifiers.",
    );
    expect(() => m.relatedWritingPrompt("p1", dir)).toThrow(/Approve/);
    m.approveOutline("p1", dir, outline.text, outline.at);
    expect(m.relatedWritingPrompt("p1", dir)).toContain("Compare alpha");
    const current = m.readMatrix("p1", dir)[0];
    m.reviewMatrixRow("p1", dir, "alpha", "Changed note", true, current.at);
    expect(m.getOutline("p1", dir)?.stale).toBe(true);
    expect(() => m.relatedWritingPrompt("p1", dir)).toThrow(/Approve/);
  });
  it("marks unlocatable extracted fields missing", async () => {
    const m = await import("../src/research/matrix.js");
    const fields = Object.fromEntries(
      m.matrixFields.map((f) => [
        f,
        {
          text: "Invented result",
          quotes: [{ page: 2, quote: "This does not occur in the paper" }],
        },
      ]),
    );
    const row = await m.analyzePaper("p1", dir, "alpha", async () =>
      JSON.stringify(fields),
    );
    expect(
      Object.values(row.fields).every(
        (cell) => cell.text.startsWith("Missing:") && !cell.quotes.length,
      ),
    ).toBe(true);
    expect(m.matrixMarkdown("p1", dir)).toContain("Missing:");
  });
  it("rejects stale row reviews and invalidates outlines when memory changes", async () => {
    const { m, row } = await analyze();
    const reviewed = m.reviewMatrixRow(
      "p1",
      dir,
      "alpha",
      "Reviewed",
      true,
      row.at,
    );
    expect(() =>
      m.reviewMatrixRow("p1", dir, "alpha", "Outdated", true, "old"),
    ).toThrow(/changed/);
    await m.buildOutline("p1", dir, async () => "Outline");
    const memory = await import("../src/research/memory.js");
    memory.saveMemory(
      "p1",
      { ...memory.readMemory("p1").fields, question: "New question" },
      0,
    );
    expect(m.getOutline("p1", dir)?.stale).toBe(true);
    writeFileSync(join(dir, "alpha.pdf"), textPdf(["Graph Models. New text."]));
    expect(() =>
      m.reviewMatrixRow("p1", dir, "alpha", "Unsafe", true, reviewed.at),
    ).toThrow(/stale/);
  });
});

describe("accepted project memory", () => {
  it("keeps proposals out of the accepted prompt and preserves version history", async () => {
    const m = await import("../src/research/memory.js");
    const original = m.readMemory("p1");
    const proposed = {
      ...original.fields,
      question: "Does graph pruning improve accuracy?",
    };
    m.proposeMemory("p1", proposed, "The user clarified their question.");
    expect(m.readMemory("p1").fields.question).toBe("");
    expect(m.memoryPrompt("p1")).toBe("");
    m.saveMemory("p1", proposed, 0);
    expect(m.memoryPrompt("p1")).toContain(proposed.question);
    expect(m.readMemory("p1").proposal).toBeUndefined();
    expect(() => m.saveMemory("p1", original.fields, 0)).toThrow(
      /changed elsewhere/,
    );
    m.saveMemory("p1", original.fields, 1);
    expect(m.readMemory("p1").history[1].fields.question).toBe(
      proposed.question,
    );
  });
});

describe("scientific consistency review", () => {
  const issue = {
    category: "numbers",
    severity: "major",
    explanation: "The number in data differs from the prose.",
    suggestion: "Reconcile the experiment and prose.",
    locations: [
      { file: "main.tex", quote: "Accuracy was 91 percent" },
      { file: "results.csv", quote: "accuracy,87" },
    ],
  };
  it("stores validated source locations and exposes changed inputs", async () => {
    writeFileSync(join(dir, "results.csv"), "metric,value\naccuracy,87\n");
    const r = await import("../src/research/review.js");
    const review = await r.reviewManuscript(
      "p1",
      dir,
      ["results.csv"],
      async () =>
        JSON.stringify({
          coverage: "Numbers in manuscript and CSV",
          issues: [issue],
        }),
    );
    expect(review.issues[0].locations[1].line).toBe(2);
    expect(review.inputs).toHaveLength(2);
    r.resolveIssue(
      "p1",
      review.issues[0].id,
      true,
      "Corrected the value",
      review.at,
    );
    expect(r.getReview("p1", dir)?.issues[0].resolved).toBe(true);
    writeFileSync(join(dir, "results.csv"), "metric,value\naccuracy,91\n");
    expect(r.getReview("p1", dir)?.stale).toBe(true);
  });
  it("does not keep model-invented file quotations and notices new manuscript files", async () => {
    const r = await import("../src/research/review.js");
    const review = await r.reviewManuscript("p1", dir, [], async () =>
      JSON.stringify({ coverage: "Manuscript", issues: [issue] }),
    );
    expect(review.issues).toEqual([]);
    expect(review.coverage).toContain("discarded");
    writeFileSync(join(dir, "new.tex"), "New conclusion");
    expect(r.getReview("p1", dir)?.stale).toBe(true);
  });
  it("rejects unattached context paths before model invocation", async () => {
    const r = await import("../src/research/review.js");
    const call = vi.fn();
    writeFileSync(join(root, "private.txt"), "private");
    await expect(
      r.reviewManuscript("p1", dir, [join(root, "private.txt")], call),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("paper reading extensions", () => {
  it("expands search concepts, returns actual passages and discards fabricated ones", async () => {
    const { semanticPaperSearch } = await import(
      "../src/research/pdfreading.js"
    );
    const call = vi
      .fn()
      .mockResolvedValueOnce('["accuracy", "evaluation"]')
      .mockResolvedValueOnce(
        JSON.stringify({
          explanation: "The result is on page 2",
          quotes: [
            { page: 2, quote },
            { page: 2, quote: "A made-up result is 100 percent." },
          ],
        }),
      );
    const result = await semanticPaperSearch(
      "p1",
      dir,
      "alpha",
      "Wie gut ist es?",
      {},
      call,
    );
    expect(result.expanded).toContain("accuracy");
    expect(result.quotes).toEqual([{ page: 2, quote }]);
    expect(result.discardedQuotes).toBe(1);
  });
  it.runIf(
    spawnSync("pdftoppm", ["-v"]).status === 0 &&
      spawnSync("tesseract", ["--version"]).status === 0,
  )(
    "renders real pages, persists OCR and invalidates earlier text assessments",
    async () => {
      const { extractPdfPages } = await import("../src/pdftext.js");
      const { manuscriptClaims, verifyClaim, evidenceView } = await import(
        "../src/research/evidence.js"
      );
      await verifyClaim("p1", dir, manuscriptClaims(dir)[0].id, supported);
      const { readingCapabilities, renderPdfPage, inspectPaperPage } =
        await import("../src/research/pdfreading.js");
      expect(await readingCapabilities()).toMatchObject({
        render: true,
        ocr: true,
      });
      const path = await renderPdfPage(join(dir, "alpha.pdf"), 2);
      expect(readFileSync(path).subarray(1, 4).toString()).toBe("PNG");
      await extractPdfPages(join(dir, "alpha.pdf"), { ocrPages: [2] });
      expect((await extractPdfPages(join(dir, "alpha.pdf")))[1]).toContain(
        "[OCR transcription",
      );
      expect(evidenceView("p1", dir)[0].status).toBe("stale");
      const call = vi.fn(
        async (_prompt: string, _images: string[]) =>
          "The page reports 91 percent; verify the visible text.",
      );
      expect(
        (await inspectPaperPage("p1", dir, "alpha", 2, "Read the result", call))
          .basis,
      ).toBe("visual_interpretation");
      expect(call.mock.calls[0]?.[1]).toEqual([path]);
    },
  );
  it("sends real image input through the OpenAI-compatible one-shot protocol", async () => {
    const { runOneShotOpenai } = await import("../src/backends/openai.js");
    const { DEFAULT_SETTINGS } = await import("../src/settings.js");
    const image = join(root, "page.png");
    writeFileSync(image, "image-bytes");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Page interpretation" } }],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await runOneShotOpenai(
      "Inspect",
      {
        ...DEFAULT_SETTINGS,
        openaiBaseUrl: "http://localhost/v1",
        openaiModel: "vision",
      },
      [image],
    );
    const request = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(request.messages[0].content[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`,
    );
  });
});

describe("bibliography structure", () => {
  it("distinguishes undefined keys, duplicate definitions, case collisions and duplicate works", async () => {
    writeFileSync(
      join(dir, "extra.bib"),
      "@article{alpha,title={Wrong work}}\n@article{ALPHA,title={Graph Models},doi={10.1234/alpha}}\n@article{copy,title={Neural Optimization},doi={10.1234/beta}}\n@string{venue = {Conference}}",
    );
    writeFileSync(
      join(dir, "main.tex"),
      "\\cite{alpha,missing}\n% \\cite{notreally}",
    );
    const { checkBibliography } = await import(
      "../src/research/bibliography.js"
    );
    const report = checkBibliography(dir);
    expect(report.entries).toBe(5);
    expect(
      report.issues
        .filter((i) => i.kind === "undefined_key")
        .map((i) => i.keys),
    ).toEqual([["missing"]]);
    expect(report.issues.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        "duplicate_key",
        "case_collision",
        "duplicate_work",
        "missing_fields",
      ]),
    );
  });
});

it("never accepts whitespace-only or invalid-page evidence", async () => {
  const { validQuotes, quoteSchema } = await import(
    "../src/research/evidence.js"
  );
  expect(
    validQuotes(
      [
        { page: 1, quote: "         " },
        { page: 0, quote },
        { page: 1.5, quote },
      ],
      [quote],
    ),
  ).toEqual([]);
  expect(quoteSchema.safeParse({ page: 1, quote: "         " }).success).toBe(
    false,
  );
});
