import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let projectDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-audit-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "blattbot-audit-proj-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function load() {
  return await import("../src/papers.js");
}

const jsonRes = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function writeBib(content: string) {
  writeFileSync(join(projectDir, "refs.bib"), content);
}

const DOI_ENTRY = `@article{lecun2015deep,
  title = {Deep learning},
  author = {LeCun, Yann},
  year = {2015},
  doi = {10.1038/nature14539}
}`;

/**
 * Route the audit's endpoints; anything unrouted throws. Title search fans out
 * to four indexes — Semantic Scholar and DBLP answer empty by default so a
 * "not found" is never confused with "every source was unreachable".
 */
function stubFetch(routes: {
  doi?: (url: string) => any;
  arxiv?: (url: string) => any;
  openalex?: (url: string) => any;
  crossrefSearch?: (url: string) => any;
  s2?: (url: string) => any;
  dblp?: (url: string) => any;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("export.arxiv.org")) return routes.arxiv ? routes.arxiv(u) : jsonRes(404, {});
      if (u.startsWith("https://api.crossref.org/works?")) {
        return routes.crossrefSearch ? routes.crossrefSearch(u) : jsonRes(200, { message: { items: [] } });
      }
      if (u.startsWith("https://api.crossref.org/works/") && routes.doi) return routes.doi(u);
      if (u.startsWith("https://api.openalex.org/works?")) {
        return routes.openalex ? routes.openalex(u) : jsonRes(200, { results: [] });
      }
      if (u.includes("api.semanticscholar.org")) return routes.s2 ? routes.s2(u) : jsonRes(200, { data: [] });
      if (u.includes("dblp.org")) return routes.dblp ? routes.dblp(u) : jsonRes(200, { result: {} });
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

describe("auditCitations", () => {
  it("verifies a DOI whose Crossref title matches, with a doi.org evidence link", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    stubFetch({ doi: () => jsonRes(200, { message: { title: ["Deep Learning"] } }) });
    const audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    expect(audit.results["lecun2015deep"]).toEqual({
      status: "verified",
      url: "https://doi.org/10.1038/nature14539",
    });
    expect(audit.at).toBeTruthy();
  });

  it("flags a mismatch with both titles when the DOI resolves to a different paper", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    stubFetch({ doi: () => jsonRes(200, { message: { title: ["Advances in Bee Keeping"] } }) });
    const audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    const r = audit.results["lecun2015deep"];
    expect(r.status).toBe("mismatch");
    expect(r.detail).toContain("Deep learning");
    expect(r.detail).toContain("Advances in Bee Keeping");
    expect(r.url).toBe("https://doi.org/10.1038/nature14539");
  });

  it("a 404 DOI is unresolved only after the title search also finds nothing", async () => {
    const papers = await load();
    writeBib(
      DOI_ENTRY +
        "\n\n@article{gone2020,\n  title = {Vanished Paper},\n  doi = {10.9999/gone}\n}",
    );
    stubFetch({
      doi: (u) =>
        u.includes("10.9999/gone")
          ? jsonRes(404, {})
          : (() => {
              throw new Error("connection reset");
            })(),
    });
    const audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    // Crossref 404s the DOI and no index knows the title either.
    expect(audit.results["gone2020"].status).toBe("unresolved");
    // A network failure is "unchecked", never "no such paper".
    expect(audit.results["lecun2015deep"].status).toBe("skipped");
    expect(audit.results["lecun2015deep"].detail).toContain("connection reset");
  });

  it("rescues a DOI Crossref does not index when another index knows the title", async () => {
    const papers = await load();
    // Plenty of real DOIs (ACM DL, preprint mirrors) are absent from Crossref;
    // that alone must never brand a correct reference unresolved.
    writeBib(DOI_ENTRY);
    stubFetch({
      doi: () => jsonRes(404, {}),
      openalex: () =>
        jsonRes(200, {
          results: [
            {
              id: "https://openalex.org/W42",
              display_name: "Deep learning",
              publication_year: 2015,
              authorships: [{ author: { display_name: "Yann LeCun" } }],
            },
          ],
        }),
    });
    const r = (await papers.auditCitations("proj1", projectDir, { delayMs: 0 })).results["lecun2015deep"];
    expect(r.status).toBe("verified");
    expect(r.detail).toMatch(/not indexed there/);
  });

  it("verifies a DOI-less entry by OpenAlex title search", async () => {
    const papers = await load();
    writeBib("@inproceedings{glove2014,\n  title = {GloVe: Global Vectors for Word Representation},\n  year = {2014}\n}");
    stubFetch({
      openalex: () =>
        jsonRes(200, {
          results: [
            {
              id: "https://openalex.org/W2250748100",
              display_name: "GloVe: Global Vectors for Word Representation",
              authorships: [],
            },
          ],
        }),
    });
    const audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    expect(audit.results["glove2014"]).toMatchObject({
      status: "verified",
      url: "https://openalex.org/W2250748100",
    });
  });

  it("falls back across indexes when one is down, and skips only when ALL are", async () => {
    const papers = await load();
    writeBib("@article{noid2020,\n  title = {A Paper Without Identifiers},\n  year = {2020}\n}");
    stubFetch({
      openalex: () => {
        throw new Error("openalex down");
      },
      crossrefSearch: () =>
        jsonRes(200, {
          message: { items: [{ DOI: "10.5555/found", title: ["A Paper Without Identifiers"] }] },
        }),
    });
    let audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    expect(audit.results["noid2020"]).toMatchObject({
      status: "verified",
      url: "https://doi.org/10.5555/found",
    });

    // "Unchecked" requires EVERY index to fail — two of four answering with no
    // results is a genuine "not found", not an outage.
    const down = (name: string) => () => {
      throw new Error(`${name} down`);
    };
    stubFetch({
      openalex: down("openalex"),
      crossrefSearch: down("crossref"),
      s2: down("semantic scholar"),
      dblp: down("dblp"),
    });
    audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    expect(audit.results["noid2020"].status).toBe("skipped");
  });

  it("reports unresolved when the searches answer but nothing matches", async () => {
    const papers = await load();
    writeBib("@article{ghost2020,\n  title = {A Paper That Does Not Exist Anywhere},\n  year = {2020}\n}");
    stubFetch({
      openalex: () => jsonRes(200, { results: [] }),
      crossrefSearch: () => jsonRes(200, { message: { items: [{ DOI: "10.1/x", title: ["Unrelated"] }] } }),
    });
    const audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    expect(audit.results["ghost2020"].status).toBe("unresolved");
  });

  it("reports unresolved for entries with neither DOI nor title", async () => {
    const papers = await load();
    writeBib("@misc{blank2020,\n  year = {2020}\n}");
    stubFetch({});
    const audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    expect(audit.results["blank2020"].status).toBe("unresolved");
  });

  it("persists the audit and reads it back — badges survive reloads", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    stubFetch({ doi: () => jsonRes(200, { message: { title: ["Deep learning"] } }) });
    expect(papers.readAudit("proj1")).toBeNull();
    const audit = await papers.auditCitations("proj1", projectDir, { delayMs: 0 });
    expect(papers.readAudit("proj1")).toEqual(audit);
    // On disk under the papers data area, isolated per project.
    const onDisk = JSON.parse(readFileSync(join(dataDir, "papers", "proj1.audit.json"), "utf8"));
    expect(onDisk).toEqual(audit);
    expect(papers.readAudit("proj2")).toBeNull();
    expect(existsSync(join(dataDir, "papers", "proj2.audit.json"))).toBe(false);
  });
});
