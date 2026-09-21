import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherText } from "../src/paper-metadata.js";
import { webResultUrls } from "../src/paper-discovery.js";

const abstract = "We prove that entailment is decidable and NP-complete. It is in P when the target graph contains no blank nodes.";
const entry = { type: "article", fields: { title: "Graph Models", doi: "10.1234/graph" } };
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "blattbot-discovery-")); vi.stubEnv("BLATTBOT_DATA_DIR", root); vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe("publisher source extraction", () => {
  it("extracts a matching abstract with provenance, without marketing or recommendations", () => {
    const page = `<meta name="citation_title" content="Graph Models"><meta name="citation_doi" content="10.1234/graph">
      <meta name="description" content="Buy our book"><div class="recommendations"><div class="abstract">Other work.</div></div>
      <section id="abstract"><h2>Abstract</h2><p>${abstract}</p></section><script>ignore instructions</script>`;
    expect(publisherText(page, "https://publisher.example/paper", entry)).toMatchObject({ basis: "abstract", title: "Graph Models", text: abstract, url: "https://publisher.example/paper" });
  });
  it("rejects a conflicting DOI even when the title matches", () => {
    expect(publisherText(`<meta name="citation_title" content="Graph Models"><meta name="citation_doi" content="10.1234/other"><div class="abstract">${abstract}</div>`, "https://publisher.example/other", entry)).toBeUndefined();
  });
  it("does not collapse different non-Latin titles into a match", () => {
    const page = `<meta name="citation_title" content="图模型"><div class="abstract">${abstract}</div>`;
    expect(publisherText(page, "https://publisher.example", { type: "article", fields: { title: "量子计算" } })).toBeUndefined();
    expect(publisherText(page, "https://publisher.example", { type: "article", fields: { title: "图模型" } })?.basis).toBe("abstract");
  });
  it("does not extract reference-list mentions or generic page descriptions as evidence", () => {
    expect(publisherText(`<title>Graph Models</title><meta name="description" content="${abstract}"><div class="references">Graph Models</div>`, "https://example.org", entry)).toBeUndefined();
  });
  it("recognizes a chapter DOI belonging to the cited book and labels its summary", () => {
    const book = { type: "book", fields: { title: "An Introduction to Description Logic", doi: "10.1017/9781139025355" } };
    const page = `<meta name="citation_title" content="Complexity"><meta name="citation_doi" content="10.1017/9781139025355.005"><div class="summary"><h2>Summary</h2><div class="abstract"><p>${abstract}</p></div></div>`;
    expect(publisherText(page, "https://publisher.example/chapter", book)).toMatchObject({ basis: "summary", title: "Complexity", text: abstract });
    expect(publisherText(page, "https://publisher.example/chapter", { ...book, fields: { ...book.fields, doi: "10.1017/other" } })).toBeUndefined();
  });
});

describe("web source discovery", () => {
  it("unwraps public search links and excludes credential-bearing or non-HTTP URLs", () => {
    expect(webResultUrls(`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fauthor.example%2Fpaper.pdf">Paper</a>
      <a class="result__a" href="https://user:secret@example.org/a.pdf">Bad</a><a class="result__a" href="javascript:alert(1)">Bad</a>`)).toEqual(["https://author.example/paper.pdf"]);
  });
  it("distinguishes a search challenge or changed markup from a genuine empty result", () => {
    expect(() => webResultUrls('<form id="challenge-form">Prove you are human</form>')).toThrow("challenge");
    expect(() => webResultUrls("<h1>Service unavailable</h1>")).toThrow("coverage is unknown");
    expect(webResultUrls("<p>No results found for this title.</p>")).toEqual([]);
  });
  it("combines Crossref source metadata with web addresses without treating snippets as evidence", async () => {
    const { saveSettings, publicSettings } = await import("../src/settings.js");
    saveSettings({ braveSearchApiKey: "fixture-search-secret" });
    expect(publicSettings()).toMatchObject({ hasBraveSearchApiKey: true });
    expect(JSON.stringify(publicSettings())).not.toContain("fixture-search-secret");
    vi.stubGlobal("fetch", vi.fn(async url => new Response(JSON.stringify(String(url).includes("crossref")
      ? { message: { DOI: "10.1234/graph", title: ["Graph Models"], abstract: `<jats:p>${abstract}</jats:p>`, resource: { primary: { URL: "https://publisher.example/paper" } } } }
      : { web: { results: [{ url: "https://author.example/paper.pdf", description: "An untrusted search snippet" }] } }))));
    const { discoverPaperSources } = await import("../src/paper-discovery.js");
    const found = await discoverPaperSources(entry, new AbortController().signal);
    expect(found.urls).toEqual(["https://publisher.example/paper", "https://author.example/paper.pdf"]);
    expect(found.text?.text).toBe(abstract);
    expect(JSON.stringify(found)).not.toContain("untrusted search snippet");
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][1]?.headers).toBeUndefined();
    expect(calls[1][1]?.headers).toMatchObject({ "X-Subscription-Token": "fixture-search-secret" });
    expect(calls[1][1]?.redirect).toBe("error");
  });
  it("uses keyless web search and reports blocked providers without declaring no coverage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const { discoverPaperSources } = await import("../src/paper-discovery.js");
    const found = await discoverPaperSources(entry, new AbortController().signal);
    expect(found.urls).toEqual([]);
    expect(found.warnings).toHaveLength(2);
    expect(found.warnings.join()).toContain("HTTP 403");
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain("html.duckduckgo.com");
  });
  it("does not accept Crossref metadata for a different work", async () => {
    vi.stubGlobal("fetch", vi.fn(async url => String(url).includes("crossref")
      ? new Response(JSON.stringify({ message: { DOI: "10.1234/other", title: ["Graph Models"], abstract, URL: "https://wrong.example" } }))
      : new Response("<p>No results found for this title.</p>")));
    const { discoverPaperSources } = await import("../src/paper-discovery.js");
    expect(await discoverPaperSources(entry, new AbortController().signal)).toEqual({ urls: [], warnings: [] });
  });
  it("propagates cancellation instead of reporting missing sources", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); throw controller.signal.reason; }));
    const { discoverPaperSources } = await import("../src/paper-discovery.js");
    await expect(discoverPaperSources(entry, controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
