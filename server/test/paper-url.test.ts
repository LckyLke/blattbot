import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textPdf } from "./fixtures/pdf.js";

vi.mock("../src/read-url.js", async original => ({
  ...await original<typeof import("../src/read-url.js")>(),
  fetchPublicUrl: vi.fn(),
}));
let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blattbot-paper-url-"));
  dir = join(root, "project");
  mkdirSync(dir);
  writeFileSync(join(dir, "refs.bib"), "@article{paper, title={Graph Models}}");
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
const pdf = (text = "Graph Models. A verified passage.") => ({ url: "https://author.example/paper.pdf", type: "application/pdf", body: textPdf([text]) });
const html = (body: string) => ({ url: "https://repository.example/item/1", type: "text/html", body: Buffer.from(body) });

describe("additional paper sources", () => {
  it("reads a supplied PDF URL, binds its source, and reuses it for later reads", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValue(pdf());
    const { readPaper, readPaperStore } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "paper", { url: "https://author.example/paper.pdf" })).toMatchObject({ basis: "full_text", source: "https://author.example/paper.pdf", excerpt: { text: expect.stringContaining("A verified passage") } });
    expect(await readPaper("p1", dir, "paper")).toMatchObject({ basis: "full_text" });
    expect(fetchPublicUrl).toHaveBeenCalledTimes(1);
    expect(fetchPublicUrl).toHaveBeenCalledWith("https://author.example/paper.pdf", expect.any(AbortSignal), 25 * 1024 * 1024);
    expect(fetch).not.toHaveBeenCalled();
    expect(readPaperStore("p1").paper.oaPdfUrl).toBe("https://author.example/paper.pdf");
    expect(readdirSync(join(root, "papers", "p1")).some(name => name.startsWith(".source-"))).toBe(false);
  });
  it("follows bibliography landing-page metadata when the indexes return no PDF", async () => {
    writeFileSync(join(dir, "refs.bib"), "@article{paper, title={Graph Models}, url={https://repository.example/item/1}}");
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValueOnce(html('<meta content="/files/actual.pdf" name="citation_pdf_url">')).mockResolvedValueOnce(pdf());
    const { readPaper } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "paper")).toMatchObject({ basis: "full_text" });
    expect(vi.mocked(fetchPublicUrl).mock.calls.map(call => call[0])).toEqual(["https://repository.example/item/1", "https://repository.example/files/actual.pdf"]);
  });
  it("follows OpenAlex repository landing pages without a pdf_url", async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).includes("api.openalex.org")
      ? new Response(JSON.stringify({ results: [{ display_name: "Graph Models", locations: [{ is_oa: true, landing_page_url: "https://repository.example/item/1" }] }] }))
      : new Response("", { status: 404 }));
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValueOnce(html('<a href="/files/paper.pdf">PDF</a>')).mockResolvedValueOnce(pdf());
    const { readPaper } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "paper")).toMatchObject({ basis: "full_text" });
  });
  it("tries another advertised PDF after a wrong paper or an access failure", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValueOnce(html('<a href="/wrong.pdf">PDF</a><a href="/blocked.pdf">PDF</a><a href="/correct.pdf">PDF</a>'))
      .mockResolvedValueOnce(pdf("An unrelated study."))
      .mockRejectedValueOnce(new Error("HTTP 403"))
      .mockResolvedValueOnce(pdf());
    const { readPaper } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "paper", { url: "https://repository.example/item/1" })).toMatchObject({ basis: "full_text" });
    expect(fetchPublicUrl).toHaveBeenCalledTimes(4);
  });
  it("does not persist a mismatched supplied PDF or silently substitute an abstract", async () => {
    writeFileSync(join(dir, "refs.bib"), "@article{paper, title={Graph Models}, abstract={Abstract available.}}");
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValue(pdf("An unrelated study."));
    const { readPaper, readPaperStore } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "paper", { url: "https://author.example/wrong.pdf" })).toMatchObject({ basis: "none", limitations: [expect.stringContaining("could not be matched")] });
    expect(readPaperStore("p1").paper).toBeUndefined();
    expect(readdirSync(join(root, "papers", "p1"))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects conflicting source arguments", async () => {
    const { readPaper } = await import("../src/papers.js");
    await expect(readPaper("p1", dir, "paper", { path: "local.pdf", url: "https://author.example/paper.pdf" })).rejects.toThrow("either a local path or a public URL");
  });
  it("extracts only PDF links, resolves entities, and skips preview PDFs and scripts", async () => {
    const { paperPdfLinks } = await import("../src/paper-url.js");
    expect(paperPdfLinks(`<script>'<a href="/fake.pdf">'</script>
      <meta content='/download?id=1&amp;format=pdf' name='citation_pdf_url'>
      <link type="application/pdf" href="/download/1">
      <a href="paper.pdf">Full text</a><a href="paper.pdf">Duplicate</a>
      <a href="/frontmatter/book.pdf">Book</a><a href="/excerpt/book.pdf">Excerpt</a>
      <a href="javascript:alert(1)">PDF</a><a href="https://user:password@example.org/file.pdf">PDF</a>`, "https://repository.example/item/1"))
      .toEqual(["https://repository.example/download?id=1&format=pdf", "https://repository.example/download/1", "https://repository.example/item/paper.pdf"]);
  });
  it("returns and caches a publisher summary without pretending it read a PDF", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    writeFileSync(join(dir, "refs.bib"), "@book{paper, title={Graph Models}, doi={10.1234/book}}");
    const text = "For general knowledge bases the satisfiability problem is EXPTIME-complete. This chapter explains the assumptions and discusses lower bounds.";
    vi.mocked(fetchPublicUrl).mockResolvedValue(html(`<meta name="citation_title" content="Complexity"><meta name="citation_doi" content="10.1234/book.005"><div class="summary"><h2>Summary</h2><p>${text}</p></div>`));
    const { readPaper, formatPaperReadResult, verifyCitationSupport } = await import("../src/papers.js");
    const result = await readPaper("p1", dir, "paper", { url: "https://repository.example/item/1" });
    expect(result).toMatchObject({ basis: "summary", pageCount: 0 });
    expect(formatPaperReadResult(result)).toContain("[Publisher summary]");
    expect(formatPaperReadResult(result)).not.toContain("[Page 1]");
    await readPaper("p1", dir, "paper", { url: "https://repository.example/item/1" });
    expect(fetchPublicUrl).toHaveBeenCalledTimes(1);
    const judge = vi.fn(async (_prompt: string) => "SUPPORTED\nExplicitly stated in the summary.");
    expect(await verifyCitationSupport("p1", dir, "paper", "EXPTIME-complete", { judge, url: "https://repository.example/item/1" })).toMatchObject({ basis: "summary" });
    expect(judge.mock.calls[0]?.[0]).toContain("chapter summary only");
    const { indexPaper, libraryStatus } = await import("../src/research/library.js");
    expect(await indexPaper("p1", dir, "paper")).toMatchObject({ basis: "summary", pages: 0 });
    expect(libraryStatus("p1", dir)).toMatchObject({ indexed: 0, abstractOnly: 0, summaryOnly: 1 });
  });
  it("invalidates evidence when a refreshed summary changes", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    const page = (word: string) => html(`<meta name="citation_title" content="Graph Models"><section id="abstract"><p>${word} ${"A source statement with enough context to explain the graph model. ".repeat(2)}</p></section>`);
    vi.mocked(fetchPublicUrl).mockResolvedValue(page("Original."));
    const { getPaperContent } = await import("../src/papers.js");
    const { sourceVersion, sourceCurrent } = await import("../src/research/evidence.js");
    const content = await getPaperContent("p1", dir, "paper", { url: "https://repository.example/item/1" });
    const version = sourceVersion("p1", dir, content);
    expect(sourceCurrent("p1", dir, version)).toBe(true);
    vi.mocked(fetchPublicUrl).mockResolvedValue(page("Corrected."));
    await getPaperContent("p1", dir, "paper", { url: "https://repository.example/item/1", refresh: true });
    expect(sourceCurrent("p1", dir, version)).toBe(false);
  });
  it("reuses unsuccessful lookups until refresh or a provider setting changes", async () => {
    const { readPaper } = await import("../src/papers.js");
    const { saveSettings } = await import("../src/settings.js");
    expect(await readPaper("p1", dir, "paper")).toMatchObject({ basis: "none" });
    const requests = vi.mocked(fetch).mock.calls.length;
    expect(requests).toBeGreaterThan(0);
    const cached = await readPaper("p1", dir, "paper");
    expect(cached.limitations.join()).toContain("refresh=true");
    expect(fetch).toHaveBeenCalledTimes(requests);
    await readPaper("p1", dir, "paper", { refresh: true });
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(requests);
    const refreshed = vi.mocked(fetch).mock.calls.length;
    saveSettings({ braveSearchApiKey: "new-key" });
    await readPaper("p1", dir, "paper");
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(refreshed);
  });
  it("never treats a preview PDF as the full cited book", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValue({ ...pdf(), url: "https://publisher.example/excerpt/book.pdf" });
    const { readPaper, readPaperStore } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "paper", { url: "https://publisher.example/excerpt/book.pdf" })).toMatchObject({ basis: "none", limitations: [expect.stringContaining("preview or excerpt")] });
    expect(readPaperStore("p1").paper?.pdfFile).toBeUndefined();
  });
  it("skips advertised PDF links that redirect to a preview", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValueOnce(html('<a href="/download.pdf">PDF</a><a href="/full.pdf">PDF</a>'))
      .mockResolvedValueOnce({ ...pdf("Graph Models. Preview contents."), url: "https://publisher.example/preview/book.pdf" })
      .mockResolvedValueOnce(pdf("Graph Models. The complete study."));
    const { readPaper } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "paper", { url: "https://repository.example/item/1" })).toMatchObject({ basis: "full_text", excerpt: { text: expect.stringContaining("complete study") } });
  });
  it("uses an updated bibliography abstract instead of stale remote metadata", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValue(html(`<meta name="citation_title" content="Graph Models"><div class="abstract">${"Old publisher text. ".repeat(8)}</div>`));
    const { readPaper } = await import("../src/papers.js");
    await readPaper("p1", dir, "paper", { url: "https://repository.example/item/1" });
    writeFileSync(join(dir, "refs.bib"), "@article{paper, title={Graph Models}, abstract={Updated abstract supplied in the bibliography.}}");
    expect(await readPaper("p1", dir, "paper")).toMatchObject({ source: "BibTeX abstract", excerpt: { text: expect.stringContaining("Updated abstract") } });
  });
  it("retries a cached failure with a newly connected publisher and keeps credentials out of results", async () => {
    writeFileSync(join(dir, "refs.bib"), "@article{paper, title={Graph Models}, url={https://publisher.example/article/1}}");
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockRejectedValue(new Error("HTTP 403"));
    const { readPaper } = await import("../src/papers.js");
    expect((await readPaper("p1", dir, "paper")).basis).toBe("none");
    const { savePublisherSession } = await import("../src/publisher-access.js");
    savePublisherSession("https://publisher.example", "Any university", [{ name: "session", value: "fixture-private-cookie", domain: "publisher.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }]);
    vi.mocked(fetchPublicUrl).mockImplementation(async (url, _signal, _limit, credentials) => {
      expect(credentials?.cookieForUrl(new URL(url))).toBe("session=fixture-private-cookie");
      expect(credentials?.cookieForUrl(new URL("https://unrelated.example"))).toBeUndefined();
      return pdf();
    });
    const result = await readPaper("p1", dir, "paper");
    expect(result.basis).toBe("full_text");
    expect(JSON.stringify(result)).not.toContain("fixture-private-cookie");
  });
  it("retries a cached publisher summary after sign-in to retrieve full text", async () => {
    const { fetchPublicUrl } = await import("../src/read-url.js");
    vi.mocked(fetchPublicUrl).mockResolvedValue(html(`<meta name="citation_title" content="Graph Models"><div class="abstract">${"Publisher abstract. ".repeat(8)}</div>`));
    const { readPaper } = await import("../src/papers.js");
    const url = "https://repository.example/item/1";
    expect((await readPaper("p1", dir, "paper", { url })).basis).toBe("abstract");
    const { savePublisherSession } = await import("../src/publisher-access.js");
    savePublisherSession("https://repository.example", "Any university", [{ name: "session", value: "fixture-cookie", domain: "repository.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }]);
    vi.mocked(fetchPublicUrl).mockResolvedValue(pdf());
    expect((await readPaper("p1", dir, "paper", { url })).basis).toBe("full_text");
  });
});
