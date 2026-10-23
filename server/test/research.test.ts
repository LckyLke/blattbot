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
describe("source versions and quotations", () => {
  it("keeps only verbatim quotations on the cited page", async () => {
    const { getPaperContent } = await import("../src/papers.js");
    const { validQuotes } = await import("../src/research/sources.js");
    const content = await getPaperContent("p1", dir, "alpha");
    expect(content.basis).toBe("full_text");
    expect(validQuotes([{ page: 2, quote }], content.pages)).toEqual([{ page: 2, quote }]);
    for (const q of [
      { page: 2, quote: "A fabricated 99 percent result." },
      { page: 1, quote },
    ]) {
      expect(validQuotes([q], content.pages)).toEqual([]);
    }
  });
  it("versions a source and goes stale when the bibliography entry or PDF bytes change", async () => {
    const { getPaperContent } = await import("../src/papers.js");
    const { bibHash, localSourcePath, sourceCurrent, sourceVersion } = await import("../src/research/sources.js");
    const version = sourceVersion("p1", dir, await getPaperContent("p1", dir, "alpha"));
    expect(version).toMatchObject({
      key: "alpha",
      basis: "full_text",
      entryHash: bibHash(dir, "alpha"),
      fileHash: expect.any(String),
      textHash: expect.any(String),
    });
    expect(localSourcePath("p1", dir, "alpha")).toBe(join(dir, "alpha.pdf"));
    expect(sourceCurrent("p1", dir, version)).toBe(true);
    writeFileSync(join(dir, "refs.bib"), bib.replace("Ada", "Alice"));
    expect(bibHash(dir, "alpha")).not.toBe(version.entryHash);
    expect(sourceCurrent("p1", dir, version)).toBe(false);
    writeFileSync(join(dir, "refs.bib"), bib);
    expect(sourceCurrent("p1", dir, version)).toBe(true);
    writeFileSync(join(dir, "alpha.pdf"), textPdf(["Graph Models. New revision.", quote]));
    expect(sourceCurrent("p1", dir, version)).toBe(false);
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
});

describe("paper reading extensions", () => {
  it.runIf(
    spawnSync("pdftoppm", ["-v"]).status === 0 &&
      /^eng$/m.test(`${spawnSync("tesseract", ["--list-langs"], { encoding: "utf8" }).stdout ?? ""}`),
  )(
    "renders real pages, persists OCR and invalidates earlier source versions",
    async () => {
      const { extractPdfPages } = await import("../src/pdftext.js");
      const { getPaperContent } = await import("../src/papers.js");
      const { sourceCurrent, sourceVersion } = await import("../src/research/sources.js");
      const version = sourceVersion("p1", dir, await getPaperContent("p1", dir, "alpha"));
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
      expect(sourceCurrent("p1", dir, version)).toBe(false);
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

it("never accepts whitespace-only or invalid-page evidence", async () => {
  const { validQuotes, quoteSchema } = await import(
    "../src/research/sources.js"
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
