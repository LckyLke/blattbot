import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textPdf } from "./fixtures/pdf.js";
let root: string, dir: string;
const bib =
  "@article{alpha,title={Graph Models},author={Ada Smith},year={2020},doi={10.1234/alpha}}\n@article{beta,title={Neural Optimization},author={Bea Jones},year={2021},doi={10.1234/beta}}";
const json = (value: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
  });
const works: Record<string, any> = {
  W1: {
    id: "https://openalex.org/W1",
    display_name: "Graph Models",
    doi: "https://doi.org/10.1234/alpha",
    publication_year: 2020,
    referenced_works: ["https://openalex.org/W2", "https://openalex.org/W3"],
  },
  W2: {
    id: "https://openalex.org/W2",
    display_name: "Neural Optimization",
    doi: "https://doi.org/10.1234/beta",
    publication_year: 2021,
    referenced_works: ["https://openalex.org/W3", "https://openalex.org/W4"],
  },
  W3: {
    id: "https://openalex.org/W3",
    display_name: "Shared Foundations",
    doi: "https://doi.org/10.1234/shared",
    publication_year: 2019,
    referenced_works: ["https://openalex.org/W1"],
  },
  W4: {
    id: "https://openalex.org/W4",
    display_name: "Missing Experiments",
    referenced_works: [],
  },
};
function graphFetch(url: string | URL | Request) {
  const text = decodeURIComponent(String(url));
  if (text.includes("openalex_id:"))
    return json({
      results: text
        .split("openalex_id:")[1]
        .split("&")[0]
        .split("|")
        .map((id) => works[id])
        .filter(Boolean),
    });
  if (text.endsWith("/alpha")) return json(works.W1);
  if (text.endsWith("/beta")) return json(works.W2);
  const id = text.split("/").pop()!;
  if (works[id]) return json(works[id]);
  return new Response("", { status: 404 });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blattbot-integrations-"));
  dir = join(root, "project");
  mkdirSync(dir);
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
  writeFileSync(join(dir, "refs.bib"), bib);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => graphFetch(url)),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("structured directed citation graph", () => {
  it("loads and caches paper details without claiming new citation edges", async () => {
    const g = await import("../src/research/graph.js");
    await g.buildGraph("p1", dir);
    const before = g.readGraph("p1", dir).edges;
    vi.mocked(fetch).mockImplementation(async () => json({ ...works.W3,
      authorships: [{ author: { display_name: "Ada Lovelace" } }],
      primary_location: { source: { display_name: "Example Journal" } },
      cited_by_count: 42, abstract_inverted_index: { "Graph": [0], "evidence": [1], ignored: [99999999] },
    }));
    const details = await g.graphDetails("p1", dir, "W3");
    expect(details).toMatchObject({ authors: ["Ada Lovelace"], venue: "Example Journal", citationCount: 42, abstract: "Graph evidence", detailsLoaded: true, referencesLoaded: false });
    const count = vi.mocked(fetch).mock.calls.length;
    await g.graphDetails("p1", dir, "W3");
    expect(fetch).toHaveBeenCalledTimes(count);
    expect(g.readGraph("p1", dir).edges).toEqual(before);
    await expect(g.graphDetails("p1", dir, "W99999")).rejects.toThrow("not in the project graph");
  });
  it("reads current manuscript citations locally, including when metadata is offline", async () => {
    const g = await import("../src/research/graph.js");
    await g.buildGraph("p1", dir);
    const source = String.raw`Related work.
We build on \cite{alpha}.
% \cite{alpha}
\nocite{alpha}`;
    writeFileSync(join(dir, "main.tex"), source);
    const result = g.queryGraph("p1", dir, { query: "citations", node: "alpha", limit: 1 });
    expect(result).toMatchObject({ total: 2, nextOffset: 1, results: [{ file: "main.tex", line: 2, kind: "citation" }] });
    vi.mocked(fetch).mockRejectedValue(new Error("Provider offline"));
    const details = await g.graphDetails("p1", dir, "alpha");
    expect(details.manuscriptCitations).toHaveLength(2);
    expect(details.manuscriptCitations?.[1]).toMatchObject({ line: 4, kind: "bibliography" });
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(source);
    writeFileSync(join(dir, "main.tex"), "No longer cited.");
    expect((await g.graphDetails("p1", dir, "alpha")).manuscriptCitations).toEqual([]);
  });
  it("retries failed metadata in batches without refetching resolved sources", async () => {
    const g = await import("../src/research/graph.js");
    vi.mocked(fetch).mockImplementation(async url => {
      if (String(url).includes("openalex_id:")) throw new TypeError("fetch failed");
      return graphFetch(url);
    });
    const partial = await g.buildGraph("p1", dir, ["alpha"]);
    expect(partial.errors.alpha).toContain("Citation edges loaded");
    expect(partial.failures?.alpha.kind).toBe("network");
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async url => graphFetch(url));
    const repaired = await g.buildGraph("p1", dir, ["alpha"]);
    expect(repaired.errors.alpha).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("per-page=100");
  });
  it("records provider retry headers and only falls back from DOI on a missing record", async () => {
    const { fetchJson, openAlexWork } = await import("../src/research/discovery.js");
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "180" } }));
    const before = Date.now();
    await expect(fetchJson("https://api.openalex.org/works/W1")).rejects.toMatchObject({ status: 429, retryAt: expect.any(String) });
    try { await openAlexWork(dir, "alpha"); } catch (error: any) { expect(Date.parse(error.retryAt)).toBeGreaterThanOrEqual(before + 180_000); }
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async url => String(url).includes("?search=") ? json({ results: [works.W1] }) : new Response("", { status: 404 }));
    expect((await openAlexWork(dir, "alpha")).id).toBe(works.W1.id);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("accepts indexed main titles only with matching DOI, author and year", async () => {
    const { openAlexWork } = await import("../src/research/discovery.js");
    writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Graph Models: learning structure},author={Smith, Ada},year={2020},doi={10.1234/alpha}}");
    const shortened = { ...works.W1, authorships: [{ author: { display_name: "Ada Smith" } }] };
    vi.mocked(fetch).mockResolvedValue(json(shortened));
    expect((await openAlexWork(dir, "alpha")).id).toBe(works.W1.id);
    vi.mocked(fetch).mockResolvedValue(json({ ...shortened, doi: "https://doi.org/10.1234/wrong" }));
    await expect(openAlexWork(dir, "alpha")).rejects.toThrow("reliably");
    vi.mocked(fetch).mockResolvedValue(json({ ...shortened, authorships: [{ author: { display_name: "Someone Else" } }] }));
    await expect(openAlexWork(dir, "alpha")).rejects.toThrow("reliably");
  });
  it("builds project and external nodes with correctly directed, dated edges", async () => {
    const g = await import("../src/research/graph.js");
    const graph = await g.buildGraph("p1", dir);
    expect(graph.pendingKeys).toEqual([]);
    expect(graph.edges).toHaveLength(4);
    expect(graph.nodes.filter((n) => n.inProject).map((n) => n.id)).toEqual([
      "W1",
      "W2",
    ]);
    expect(graph.edges).toContainEqual({
      from: "W1",
      to: "W2",
      source: "OpenAlex",
      at: expect.any(String),
    });
    expect(graph.edges.some((e) => e.from === "W3")).toBe(false); // metadata hydration does not claim reference retrieval
    expect(
      (
        g.queryGraph("p1", dir, {
          query: "neighbors",
          node: "alpha",
          direction: "outgoing",
        }) as any
      ).results.map((r: any) => r.node.id),
    ).toEqual(["W2", "W3"]);
    expect(
      (
        g.queryGraph("p1", dir, {
          query: "neighbors",
          node: "alpha",
          direction: "incoming",
        }) as any
      ).results,
    ).toEqual([]);
  });
  it("finds common references, ranks missing works, and paginates without a model", async () => {
    const g = await import("../src/research/graph.js");
    await g.buildGraph("p1", dir);
    expect(
      (
        g.queryGraph("p1", dir, {
          query: "shared_references",
          nodes: ["alpha", "beta"],
        }) as any
      ).results.map((n: any) => n.id),
    ).toEqual(["W3"]);
    const missing: any = g.queryGraph("p1", dir, {
      query: "missing",
      limit: 1,
    });
    expect(missing.results[0].node.id).toBe("W3");
    expect(missing.results[0].citedBy).toHaveLength(2);
    expect(missing.total).toBe(2);
    expect(missing.nextOffset).toBe(1);
    expect(
      (g.queryGraph("p1", dir, { query: "missing", offset: 1 }) as any)
        .results[0].node.id,
    ).toBe("W4");
  });
  it("respects path direction and maximum depth, terminates on cycles", async () => {
    const g = await import("../src/research/graph.js");
    await g.buildGraph("p1", dir);
    expect(
      g.queryGraph("p1", dir, {
        query: "path",
        node: "alpha",
        target: "W4",
        maxDepth: 1,
      }),
    ).toMatchObject({ found: false });
    expect(
      (
        g.queryGraph("p1", dir, {
          query: "path",
          node: "alpha",
          target: "W4",
        }) as any
      ).path.map((n: any) => n.id),
    ).toEqual(["W1", "W2", "W4"]);
    expect(
      g.queryGraph("p1", dir, { query: "path", node: "W4", target: "alpha" }),
    ).toMatchObject({ found: false });
    expect(
      g.queryGraph("p1", dir, {
        query: "path",
        node: "W4",
        target: "alpha",
        direction: "both",
      }),
    ).toMatchObject({ found: true });
    await g.expandGraph("p1", dir, "W3");
    expect(
      g.queryGraph("p1", dir, { query: "path", node: "W3", target: "W4" }),
    ).toMatchObject({ found: true });
  });
  it("recognizes a newly imported external work as a project source", async () => {
    const g = await import("../src/research/graph.js");
    await g.buildGraph("p1", dir);
    writeFileSync(
      join(dir, "refs.bib"),
      bib +
        "\n@article{shared,title={Shared Foundations},doi={10.1234/shared}}",
    );
    expect(
      g.readGraph("p1", dir).nodes.find((n) => n.id === "W3"),
    ).toMatchObject({ keys: ["shared"], inProject: true });
    expect(
      (g.queryGraph("p1", dir, { query: "missing" }) as any).results.map(
        (n: any) => n.node.id,
      ),
    ).toEqual(["W4"]);
  });
  it("marks edited/unresolved bibliography sources pending and reports remote failures", async () => {
    const g = await import("../src/research/graph.js");
    await g.buildGraph("p1", dir);
    writeFileSync(
      join(dir, "refs.bib"),
      bib
        .replace("Graph Models", "A completely different work")
        .replace("10.1234/alpha", "10.9999/new"),
    );
    const graph = g.readGraph("p1", dir);
    expect(graph.pendingKeys).toContain("alpha");
    expect(graph.nodes.find((n) => n.id === "bib:alpha")?.resolved).toBe(false);
    expect(graph.edges.some((e) => e.from === "W1")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 })),
    );
    expect((await g.buildGraph("p1", dir)).errors.alpha).toContain("429");
    await expect(g.expandGraph("p1", dir, "W999")).rejects.toThrow(/not in/);
  });
  it("registers graph tools in read-only Codex/OpenAI catalogs and returns structured JSON", async () => {
    const { toolDefinitions, executeTool } = await import(
      "../src/backends/openai.js"
    );
    const names = toolDefinitions(true).map((t) => t.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "query_citation_graph",
        "update_citation_graph",
        "check_bibliography",
        "verify_evidence",
        "project_memory",
      ]),
    );
    const g = await import("../src/research/graph.js");
    await g.buildGraph("p1", dir);
    const result = await executeTool(
      {
        project: { id: "p1" },
        dir,
        readOnly: true,
        signal: new AbortController().signal,
        emit: vi.fn(),
      } as any,
      "query_citation_graph",
      { query: "missing" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).results[0].citedBy).toHaveLength(2);
  });
});

describe("discovery snapshots and publication status", () => {
  it("records citation searches and screening decisions with dates", async () => {
    const d = await import("../src/research/discovery.js");
    const run = await d.citationNeighbors("p1", dir, "alpha", "references");
    expect(run.results.map((h) => h.title)).toEqual([
      "Neural Optimization",
      "Shared Foundations",
    ]);
    d.screeningDecision(
      "p1",
      run.id,
      run.results[0].ref,
      "include",
      "Relevant comparator",
    );
    expect(d.searchHistory("p1")[0].decisions[run.results[0].ref].reason).toBe(
      "Relevant comparator",
    );
    expect(() =>
      d.screeningDecision("p1", run.id, "missing-ref", "exclude", "Wrong"),
    ).toThrow(/not part/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const failed = await d.citationNeighbors("p1", dir, "alpha", "citing");
    expect(failed.error).toContain("503");
    expect(d.searchHistory("p1")).toHaveLength(2);
  });
  it("queries notices targeting the original DOI instead of retracting a retraction notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = decodeURIComponent(String(url));
        if (u.includes("openalex")) return graphFetch(url);
        if (u.includes("filter=updates:"))
          return json({
            message: {
              items: [
                {
                  DOI: "10.1234/notice",
                  "update-to": [
                    {
                      DOI: "10.1234/alpha",
                      type: "retraction",
                      source: "retraction-watch",
                    },
                  ],
                },
              ],
            },
          });
        return json({
          message: {
            title: ["Graph Models"],
            "update-to": [{ DOI: "10.1234/unrelated", type: "retraction" }],
          },
        });
      }),
    );
    const d = await import("../src/research/discovery.js");
    const result = await d.publicationStatus("p1", dir, "alpha");
    expect(result.status).toBe("retracted");
    expect(result.notices).toEqual([
      { type: "retraction", doi: "10.1234/notice", source: "retraction-watch" },
    ]);
    writeFileSync(
      join(dir, "refs.bib"),
      bib.replace("Graph Models", "Changed title"),
    );
    expect(d.readPublicationStatuses("p1", dir).alpha.stale).toBe(true);
  });
  it("does not interpret update-to on the current record as that record being retracted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).includes("openalex")
          ? graphFetch(url)
          : json({
              message: String(url).includes("filter=")
                ? { items: [] }
                : {
                    title: ["Graph Models"],
                    "update-to": [{ DOI: "10.1234/other", type: "retraction" }],
                  },
            }),
      ),
    );
    const d = await import("../src/research/discovery.js");
    expect((await d.publicationStatus("p1", dir, "alpha")).status).toBe(
      "not_flagged",
    );
  });
  it("keeps an OpenAlex status with explicit coverage limits when Crossref does not index the DOI", async () => {
    vi.stubGlobal("fetch", vi.fn(async url => String(url).includes("openalex")
      ? json({ ...works.W1, is_retracted: false }) : new Response("", { status: 404 })));
    const { publicationStatus } = await import("../src/research/discovery.js");
    const result = await publicationStatus("p1", dir, "alpha");
    expect(result.status).toBe("not_flagged");
    expect(result.note).toContain("does not index this DOI");
    expect(result.note).toContain("incomplete");
  });
  it("preserves an independent retraction flag when Crossref fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).includes("openalex")
          ? json({ ...works.W1, is_retracted: true })
          : new Response("", { status: 503 }),
      ),
    );
    const d = await import("../src/research/discovery.js");
    const result = await d.publicationStatus("p1", dir, "alpha");
    expect(result.status).toBe("retracted");
    expect(result.note).toContain("incomplete");
  });
  it("supports optional OpenAlex authentication without sending the key to other indexes", async () => {
    vi.stubEnv("OPENALEX_API_KEY", "test-secret");
    const f = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", f);
    const d = await import("../src/research/discovery.js");
    await d.fetchJson("https://api.openalex.org/works/W1");
    await d.fetchJson("https://api.crossref.org/works/example");
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][1].headers).toMatchObject({
      Authorization: "Bearer test-secret",
    });
    expect(calls[1][1].headers).not.toHaveProperty("Authorization");
  });
});

describe("Zotero read-only import", () => {
  it("masks keys, locks down the secret file, and sends credentials only to the configured library", async () => {
    const z = await import("../src/research/zotero.js");
    const publicConfig = z.configureZotero("p1", {
      mode: "web",
      libraryType: "users",
      libraryId: "123",
      apiKey: "private-key",
    });
    expect(publicConfig).not.toHaveProperty("apiKey");
    expect(publicConfig.hasApiKey).toBe(true);
    // Windows does not expose POSIX owner/group/other permission bits.
    if (process.platform !== "win32") {
      expect(
        statSync(join(root, "research-secrets", "p1.json")).mode & 0o777,
      ).toBe(0o600);
    }
    const f = vi.fn(async () =>
      json(
        [
          {
            key: "ABCD1234",
            version: 1,
            data: {
              title: "Graph Models",
              itemType: "journalArticle",
              creators: [{ name: "Ada" }],
            },
          },
        ],
        { "Total-Results": "1" },
      ),
    );
    vi.stubGlobal("fetch", f);
    expect((await z.listZotero("p1", "graph")).items[0].title).toBe(
      "Graph Models",
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.zotero.org/users/123/items/top");
    expect(init.headers).toMatchObject({ "Zotero-API-Key": "private-key" });
    expect(init.method).toBeUndefined();
  });
  it("imports and safely binds PDFs without replacing an existing user upload", async () => {
    const uploads = join(root, "context", "p1");
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, "alpha.pdf"), "user-owned");
    const z = await import("../src/research/zotero.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("format=bibtex"))
          return new Response(
            "@article{alpha,title={Graph Models},doi={10.1234/alpha}}",
          );
        if (u.includes("/children"))
          return json([
            {
              key: "PDF01234",
              data: { contentType: "application/pdf", itemType: "attachment" },
            },
          ]);
        if (u.endsWith("/file"))
          return new Response(
            textPdf(["Graph Models. The imported original PDF."]),
          );
        return json({ version: 7 });
      }),
    );
    const result = await z.importZotero("p1", dir, "ABCD1234");
    expect(result.citeKey).toBe("alpha");
    expect(result.pdfPath).toContain("zotero-ABCD1234-");
    expect(result.warnings).toEqual([]);
    expect(readFileSync(join(uploads, "alpha.pdf"), "utf8")).toBe("user-owned");
    const { getPaperContent } = await import("../src/papers.js");
    expect((await getPaperContent("p1", dir, "alpha")).pages[0]).toContain(
      "imported original",
    );
  });
  it("keeps a successful bibliography import and reports missing attachments", async () => {
    const z = await import("../src/research/zotero.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).endsWith("format=bibtex")
          ? new Response(
              "@article{gamma,title={New Publication},author={Ada Smith},year={2024}}",
            )
          : new Response("", { status: 403 }),
      ),
    );
    const result = await z.importZotero("p1", dir, "ABCD1234");
    expect(result.citeKey).toBe("gamma");
    expect(result.warnings.join(" ")).toContain("403");
    expect(readFileSync(join(dir, "refs.bib"), "utf8")).toContain(
      "New Publication",
    );
  });
});

it("reports an omitted index reference list as unknown, not an empty list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ ...works.W1, referenced_works: undefined })),
  );
  const graph = await (
    await import("../src/research/graph.js")
  ).buildGraph("p1", dir, ["alpha"]);
  expect(graph.pendingKeys).toContain("alpha");
  expect(graph.errors.alpha).toContain("coverage is unknown");
});

it("imports Zotero notes as clearly labeled text and strips active markup", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("format=bibtex"))
        return new Response(
          "@article{alpha,title={Graph Models},doi={10.1234/alpha}}",
        );
      if (u.includes("/children"))
        return json([
          {
            key: "NOTE1234",
            data: {
              itemType: "note",
              note: "<p>Read the <b>limitations</b>.</p><script>bad()</script>",
            },
          },
        ]);
      return json({ version: 1 });
    }),
  );
  const result = await (
    await import("../src/research/zotero.js")
  ).importZotero("p1", dir, "ABCD1234");
  const notes = readFileSync(result.notesPath!, "utf8");
  expect(notes).toContain("user notes, not the original paper");
  expect(notes).toContain("Read the limitations.");
  expect(notes).not.toContain("<script>");
  expect(notes).not.toContain("bad()");
});
