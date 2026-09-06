import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Verification of references at the moment they are written (add_citation) and
 * on demand (audit_citations) — the deterministic guard against a fabricated
 * or mistyped entry reaching the bibliography unnoticed.
 */

let dataDir: string;
let projectDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-verify-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "blattbot-verify-proj-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const load = () => import("../src/papers.js");
const loadCitations = () => import("../src/citations.js");

const jsonRes = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const crossrefWork = (title: string) => jsonRes(200, { message: { title: [title] } });

/**
 * searchPapers queries FOUR indexes (Semantic Scholar, DBLP, Crossref,
 * OpenAlex). A stub that only knows two makes every source fail, which the
 * audit correctly reports as "unavailable" rather than "not found".
 */
const isTitleSearch = (u: string) =>
  u.startsWith("https://api.openalex.org/works?") ||
  u.startsWith("https://api.crossref.org/works?") ||
  u.includes("api.semanticscholar.org") ||
  u.includes("dblp.org");

/** All four title indexes answer successfully, with no results. */
const emptyTitleSearch = () => jsonRes(200, { results: [], message: { items: [] }, data: [], result: {} });

function writeBib(content: string) {
  writeFileSync(join(projectDir, "refs.bib"), content);
}

const ATTENTION = `@inproceedings{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish},
  year = {2017},
  doi = {10.5555/3295222.3295349}
}`;

/** A hand-written entry for a paper that does not exist — the fabrication case. */
const FABRICATED = `@article{ghost2019quantum,
  title = {Quantum Approaches to Nonexistent Problems},
  author = {Ghost, A.},
  year = {2019}
}`;

describe("verify on add (add_citation → deterministic check)", () => {
  it("reports a matching record as verified and persists the badge", async () => {
    writeBib(ATTENTION);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).startsWith("https://api.crossref.org/works/")) {
          return crossrefWork("Attention Is All You Need");
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { verifyEntry, readAudit } = await load();

    const result = await verifyEntry("proj1", projectDir, "vaswani2017attention");

    expect(result?.status).toBe("verified");
    expect(result?.url).toBe("https://doi.org/10.5555/3295222.3295349");
    // Persisted, so the Refs badge appears without a full re-audit.
    expect(readAudit("proj1")?.results["vaswani2017attention"].status).toBe("verified");
  });

  it("flags an entry whose DOI resolves to a different work as a mismatch", async () => {
    writeBib(ATTENTION);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => crossrefWork("Deep Residual Learning for Image Recognition")),
    );
    const { verifyEntry, readAudit } = await load();

    const result = await verifyEntry("proj1", projectDir, "vaswani2017attention");

    expect(result?.status).toBe("mismatch");
    expect(result?.detail).toContain("Deep Residual Learning");
    expect(readAudit("proj1")?.results["vaswani2017attention"].status).toBe("mismatch");
  });

  it("flags a hand-written entry that no index knows as unresolved", async () => {
    writeBib(FABRICATED);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (isTitleSearch(u)) return emptyTitleSearch();
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const { verifyEntry } = await load();

    const result = await verifyEntry("proj1", projectDir, "ghost2019quantum");

    expect(result?.status).toBe("unresolved");
  });

  it("never throws or blocks the add when the lookup itself fails", async () => {
    writeBib(ATTENTION);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { verifyEntry } = await load();

    // Offline is "unchecked", NOT "unresolved" — the distinction matters.
    await expect(verifyEntry("proj1", projectDir, "vaswani2017attention")).resolves.toMatchObject({
      status: "skipped",
    });
  });

  it("returns undefined for a key that is not in any .bib file", async () => {
    writeBib(ATTENTION);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not be called"); }));
    const { verifyEntry } = await load();

    await expect(verifyEntry("proj1", projectDir, "nosuchkey")).resolves.toBeUndefined();
  });

  it("works without a projectId (no persistence, still verifies)", async () => {
    writeBib(ATTENTION);
    vi.stubGlobal("fetch", vi.fn(async () => crossrefWork("Attention Is All You Need")));
    const { verifyEntry, readAudit } = await load();

    const result = await verifyEntry(undefined, projectDir, "vaswani2017attention");

    expect(result?.status).toBe("verified");
    expect(readAudit("proj1")).toBeNull();
  });
});

describe("audit_citations tool (targeted re-checks)", () => {
  it("checks only the requested keys and reports unknown ones", async () => {
    writeBib(`${ATTENTION}\n\n${FABRICATED}`);
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        seen.push(String(url));
        return crossrefWork("Attention Is All You Need");
      }),
    );
    const { auditEntries } = await load();

    const { results, unknownKeys } = await auditEntries(
      "proj1",
      projectDir,
      ["vaswani2017attention", "typo2020key"],
      { delayMs: 0 },
    );

    expect(Object.keys(results)).toEqual(["vaswani2017attention"]);
    expect(unknownKeys).toEqual(["typo2020key"]);
    // The untargeted entry was never looked up.
    expect(seen.every((u) => !u.includes("Nonexistent"))).toBe(true);
  });

  it("merges into the stored audit instead of wiping other entries' verdicts", async () => {
    writeBib(`${ATTENTION}\n\n${FABRICATED}`);
    vi.stubGlobal("fetch", vi.fn(async () => crossrefWork("Attention Is All You Need")));
    const { auditEntries, recordAuditResults, readAudit } = await load();

    recordAuditResults("proj1", { ghost2019quantum: { status: "unresolved", detail: "earlier run" } });
    await auditEntries("proj1", projectDir, ["vaswani2017attention"], { delayMs: 0 });

    const stored = readAudit("proj1")!;
    expect(stored.results["vaswani2017attention"].status).toBe("verified");
    expect(stored.results["ghost2019quantum"].status).toBe("unresolved"); // survived
  });

  it("audits the whole bibliography when no keys are given", async () => {
    writeBib(`${ATTENTION}\n\n${FABRICATED}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith("https://api.crossref.org/works/")) return crossrefWork("Attention Is All You Need");
        if (isTitleSearch(u)) return emptyTitleSearch();
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const { auditEntries } = await load();

    const { results } = await auditEntries("proj1", projectDir, undefined, { delayMs: 0 });

    expect(results["vaswani2017attention"].status).toBe("verified");
    expect(results["ghost2019quantum"].status).toBe("unresolved");
  });

  it("one entry's crash never sinks the run", async () => {
    writeBib(`${ATTENTION}\n\n${FABRICATED}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith("https://api.crossref.org/works/")) throw new Error("boom");
        return jsonRes(200, { results: [] });
      }),
    );
    const { auditEntries } = await load();

    const { results } = await auditEntries("proj1", projectDir, undefined, { delayMs: 0 });

    expect(results["vaswani2017attention"].status).toBe("skipped");
    expect(results["ghost2019quantum"]).toBeDefined();
  });
});

describe("agent-facing wording", () => {
  it("tells the agent to act on a mismatch, not to move on", async () => {
    const { formatVerification } = await loadCitations();
    const text = formatVerification({
      status: "mismatch",
      detail: 'entry title "A" vs Crossref "B"',
      url: "https://doi.org/10.1/x",
    });
    expect(text).toContain("VERIFICATION FAILED");
    expect(text).toMatch(/do not cite it as-is/i);
    expect(text).toContain("https://doi.org/10.1/x");
  });

  it("calls an unresolved entry out as possibly fabricated", async () => {
    const { formatVerification } = await loadCitations();
    expect(formatVerification({ status: "unresolved", detail: "no match" })).toMatch(/fabricated/i);
  });

  it("distinguishes an unchecked entry from a failed one", async () => {
    const { formatVerification } = await loadCitations();
    const text = formatVerification({ status: "skipped", detail: "Crossref unreachable" });
    expect(text).toMatch(/skipped/i);
    expect(text).not.toMatch(/fabricated|FAILED/);
  });

  it("appends the verdict to the add_citation result the agent reads", async () => {
    const { formatAddCitationResult } = await loadCitations();
    const text = formatAddCitationResult(
      { status: "added", key: "vaswani2017attention", bibFile: "refs.bib" },
      { status: "unresolved", detail: "no record" },
    );
    expect(text).toContain("Added to refs.bib");
    expect(text).toMatch(/NOT VERIFIED/);
  });

  it("omits the verdict line when no verification ran", async () => {
    const { formatAddCitationResult } = await loadCitations();
    const text = formatAddCitationResult({ status: "added", key: "k", bibFile: "refs.bib" });
    expect(text).toBe("Added to refs.bib as \\cite{k}.");
  });

  it("summarizes an audit run with counts and per-entry verdicts", async () => {
    const { formatAuditReport } = await load();
    const report = formatAuditReport(
      {
        good: { status: "verified" },
        bad: { status: "mismatch", detail: 'entry "A" vs Crossref "B"', url: "https://doi.org/10.1/x" },
        ghost: { status: "unresolved", detail: "no record" },
      },
      ["typo2020"],
    );
    expect(report).toContain("1 verified, 1 mismatch, 1 unresolved");
    // Problems are listed before the entries that are fine.
    expect(report.indexOf("MISMATCH")).toBeLessThan(report.indexOf("VERIFIED"));
    expect(report).toContain("\\cite{bad}");
    expect(report).toContain("typo2020");
    expect(report).toMatch(/never leave an unverified reference unmentioned/i);
  });

  it("does not nag when every entry is verified", async () => {
    const { formatAuditReport } = await load();
    const report = formatAuditReport({ a: { status: "verified" }, b: { status: "verified" } });
    expect(report).toContain("2 verified");
    expect(report).not.toMatch(/Fix or remove/);
  });
});

describe("record matching (false positives cost trust)", () => {
  /** The real Crossref record for the AMIE paper: title split across fields. */
  const AMIE_MSG = {
    title: ["AMIE"],
    subtitle: ["association rule mining under incomplete evidence in ontological knowledge bases"],
    author: [{ family: "Galárraga", given: "Luis Antonio" }],
    issued: { "date-parts": [[2013, 5, 13]] },
  };
  const AMIE_ENTRY = {
    title: "AMIE: association rule mining under incomplete evidence in ontological knowledge bases",
    author: "Galárraga, Luis Antonio and Teflioudi, Christina and Hose, Katja",
    year: "2013",
  };

  it("builds every way the record writes its title, including title+subtitle", async () => {
    const { titleCandidates } = await load();
    const cands = titleCandidates(AMIE_MSG);
    expect(cands).toContain("AMIE");
    expect(cands).toContain(
      "AMIE: association rule mining under incomplete evidence in ontological knowledge bases",
    );
  });

  it("accepts an entry whose title Crossref splits into title + subtitle", async () => {
    const { titleCandidates, matchesRecord } = await load();
    expect(matchesRecord(AMIE_ENTRY, titleCandidates(AMIE_MSG), {
      author: "Galárraga Luis Antonio",
      year: "2013",
    })).toMatchObject({ ok: true });
  });

  it("accepts a short entry title against a fuller record title", async () => {
    const { titleCandidates, matchesRecord } = await load();
    const r = matchesRecord({ title: "AMIE", year: "2013" }, titleCandidates(AMIE_MSG), { year: "2013" });
    expect(r.ok).toBe(true);
  });

  it("accepts a differently-written but related title when author AND year corroborate", async () => {
    const { matchesRecord } = await load();
    const r = matchesRecord(
      { title: "Rule mining under incomplete evidence", author: "Galárraga, Luis", year: "2013" },
      ["Rule mining in ontological knowledge bases"],
      { author: "Galárraga Luis Antonio", year: "2013" },
    );
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/author and year match/);
  });

  it("refuses author+year corroboration for an unrelated title — the wrong-DOI case", async () => {
    const { matchesRecord } = await load();
    // A mistyped identifier commonly lands on another paper by the same
    // authors in the same year; matching metadata must not rubber-stamp it.
    const r = matchesRecord(
      { title: "Rule mining in knowledge bases", author: "Galárraga, Luis", year: "2013" },
      ["A completely different phrasing entirely"],
      { author: "Galárraga Luis Antonio", year: "2013" },
    );
    expect(r.ok).toBe(false);
  });

  it("STILL flags a DOI that resolves to a genuinely different paper", async () => {
    const { titleCandidates, matchesRecord } = await load();
    const r = matchesRecord(
      { title: "Deep Residual Learning for Image Recognition", author: "He, Kaiming", year: "2016" },
      titleCandidates(AMIE_MSG),
      { author: "Galárraga Luis Antonio", year: "2013" },
    );
    expect(r.ok).toBe(false);
  });

  it("does not accept on a matching year alone", async () => {
    const { matchesRecord } = await load();
    const r = matchesRecord(
      { title: "Something else entirely", author: "Nobody, A.", year: "2013" },
      ["AMIE"],
      { author: "Galárraga Luis Antonio", year: "2013" },
    );
    expect(r.ok).toBe(false);
  });

  it("verifies the split-title entry end to end through auditEntry", async () => {
    writeBib(`@inproceedings{galarraga2013amie,
  title = {AMIE: association rule mining under incomplete evidence in ontological knowledge bases},
  author = {Gal\\'arraga, Luis Antonio and Teflioudi, Christina},
  year = {2013},
  doi = {10.1145/2488388.2488425}
}`);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { message: AMIE_MSG })));
    const { verifyEntry } = await load();

    const result = await verifyEntry("proj1", projectDir, "galarraga2013amie");

    expect(result?.status).toBe("verified");
  });
});

describe("accepting an entry the audit flagged", () => {
  const FLAGGED = `@article{disputed2020,
  title = {A Correct But Unverifiable Paper},
  author = {Author, A.},
  year = {2020},
  doi = {10.1/disputed}
}`;

  it("records the user's judgement and reports it as accepted", async () => {
    writeBib(FLAGGED);
    const { acceptAuditEntry, recordAuditResults, readAudit } = await load();
    recordAuditResults("proj1", { disputed2020: { status: "mismatch", detail: "titles disagree" } });

    const result = acceptAuditEntry("proj1", projectDir, "disputed2020");

    expect(result.status).toBe("verified");
    expect(result.accepted).toBe(true);
    expect(result.detail).toContain("accepted by you");
    expect(readAudit("proj1")?.results["disputed2020"].accepted).toBe(true);
  });

  it("keeps the acceptance on re-audit, without hitting the network", async () => {
    writeBib(FLAGGED);
    const fetchSpy = vi.fn(async () => { throw new Error("must not be called"); });
    vi.stubGlobal("fetch", fetchSpy);
    const { acceptAuditEntry, auditEntries } = await load();
    acceptAuditEntry("proj1", projectDir, "disputed2020");

    const { results } = await auditEntries("proj1", projectDir, undefined, { delayMs: 0 });

    expect(results["disputed2020"].accepted).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retires the acceptance once the entry itself changes", async () => {
    writeBib(FLAGGED);
    const { acceptAuditEntry, auditEntries } = await load();
    acceptAuditEntry("proj1", projectDir, "disputed2020");
    // The entry is edited: what the user vouched for no longer exists.
    writeBib(FLAGGED.replace("A Correct But Unverifiable Paper", "A Totally Different Title"));
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { message: { title: ["Something Else"] } })));

    const { results } = await auditEntries("proj1", projectDir, undefined, { delayMs: 0 });

    expect(results["disputed2020"].accepted).toBeFalsy();
    expect(results["disputed2020"].status).toBe("mismatch");
  });

  it("refuses to accept a key that is not in the bibliography", async () => {
    writeBib(FLAGGED);
    const { acceptAuditEntry } = await load();
    expect(() => acceptAuditEntry("proj1", projectDir, "nosuchkey")).toThrow(/unknown citation key/);
  });
});


describe("preprints and non-Crossref venues (the false-positive class)", () => {
  const DRUM = `@article{sadeghian2019drum,
  title = {DRUM: End-To-End Differentiable Rule Mining On Knowledge Graphs},
  author = {Sadeghian, Ali and Armandpour, Mohammadreza},
  year = {2019},
  doi = {10.48550/arXiv.1911.00055}
}`;

  const arxivFeed = (title: string, author = "Ali Sadeghian", year = "2019") =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>` +
    `<title>${title}</title><author><name>${author}</name></author>` +
    `<published>${year}-11-01T00:00:00Z</published></entry></feed>`;

  const textRes = (body: string, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => ({}),
  });

  it("verifies an arXiv DOI against arXiv — Crossref never indexes 10.48550", async () => {
    writeBib(DRUM);
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        seen.push(u);
        if (u.startsWith("https://export.arxiv.org/api/query")) {
          return textRes(arxivFeed("DRUM: End-To-End Differentiable Rule Mining On Knowledge Graphs"));
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const { verifyEntry } = await load();

    const result = await verifyEntry("proj1", projectDir, "sadeghian2019drum");

    expect(result?.status).toBe("verified");
    expect(result?.url).toBe("https://arxiv.org/abs/1911.00055");
    // Crossref is not even asked for an arXiv DOI.
    expect(seen.every((u) => !u.startsWith("https://api.crossref.org/works/10.48550"))).toBe(true);
  });

  it("uses the eprint field when the entry carries no DOI", async () => {
    writeBib(`@article{lee2023ingram,
  title = {InGram: Inductive Knowledge Graph Embedding via Relation Graphs},
  author = {Lee, Jaejun},
  year = {2023},
  eprint = {2305.19987}
}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes("export.arxiv.org")) {
          expect(u).toContain("2305.19987");
          return textRes(arxivFeed("InGram: Inductive Knowledge Graph Embedding via Relation Graphs", "Jaejun Lee", "2023"));
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const { verifyEntry } = await load();
    expect((await verifyEntry("proj1", projectDir, "lee2023ingram"))?.status).toBe("verified");
  });

  it("falls back to a multi-index title search when a DOI is not in Crossref", async () => {
    writeBib(ATTENTION); // an ACM DOI Crossref does not hold either
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith("https://api.crossref.org/works/")) return jsonRes(404, {});
        if (u.startsWith("https://api.openalex.org/works?")) {
          return jsonRes(200, {
            results: [
              {
                id: "https://openalex.org/W123",
                display_name: "Attention Is All You Need",
                publication_year: 2017,
                authorships: [{ author: { display_name: "Ashish Vaswani" } }],
              },
            ],
          });
        }
        // The other three sources answer with nothing.
        return emptyTitleSearch();
      }),
    );
    const { verifyEntry } = await load();

    const result = await verifyEntry("proj1", projectDir, "vaswani2017attention");

    expect(result?.status).toBe("verified");
    expect(result?.detail).toMatch(/not indexed there/);
  });

  it("keeps a mismatch authoritative — a title search never softens it", async () => {
    writeBib(DRUM);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("export.arxiv.org")) {
          return textRes(arxivFeed("A Completely Different Paper About Something Else"));
        }
        throw new Error("the title search must not run after a mismatch");
      }),
    );
    const { verifyEntry } = await load();

    const result = await verifyEntry("proj1", projectDir, "sadeghian2019drum");

    expect(result?.status).toBe("mismatch");
  });

  it("treats a withdrawn/non-existent arXiv id as unresolved, then tries the title", async () => {
    writeBib(DRUM);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes("export.arxiv.org")) return textRes(arxivFeed("Error"));
        return emptyTitleSearch(); // every title index answers, with nothing
      }),
    );
    const { verifyEntry } = await load();

    expect((await verifyEntry("proj1", projectDir, "sadeghian2019drum"))?.status).toBe("unresolved");
  });

  it("does not report 'no such paper' when the lookup itself was unreachable", async () => {
    writeBib(DRUM);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { verifyEntry } = await load();

    // Identifier check failed with a network error and the title search found
    // nothing — that is "unchecked", not "fabricated".
    expect((await verifyEntry("proj1", projectDir, "sadeghian2019drum"))?.status).toBe("skipped");
  });
});

describe("backend wiring (the seam that actually runs it)", () => {
  /** A ctx shaped like the OpenAI backend's turn context. */
  const ctxFor = (dir: string) => ({ dir, contextDirs: [], readOnly: false, project: { id: "proj1" }, signal: new AbortController().signal }) as any;

  it("add_citation verifies the entry it just wrote and says so in the tool result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        // BibTeX fetch for the DOI (content negotiation against doi.org).
        if (u.startsWith("https://doi.org/")) {
          return {
            ok: true,
            status: 200,
            text: async () => ATTENTION,
            json: async () => ({}),
          };
        }
        // The verification lookup — resolves to a DIFFERENT paper.
        if (u.startsWith("https://api.crossref.org/works/")) {
          return crossrefWork("Deep Residual Learning for Image Recognition");
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const { executeTool } = await import("../src/backends/openai.js");
    const { readAudit } = await load();

    const out = await executeTool(ctxFor(projectDir), "add_citation", { ref: "10.5555/3295222.3295349" });

    expect(out.isError).toBe(false);
    expect(out.content).toContain("Added to");
    // The agent is told, in the same tool result, that the entry is wrong.
    expect(out.content).toMatch(/VERIFICATION FAILED/);
    expect(out.content).toContain("Deep Residual Learning");
    // And the Refs badge is already flagged without a separate audit run.
    expect(readAudit("proj1")?.results["vaswani2017attention"].status).toBe("mismatch");
  });

  it("add_citation still succeeds when verification is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith("https://doi.org/")) {
          return { ok: true, status: 200, text: async () => ATTENTION, json: async () => ({}) };
        }
        throw new Error("offline");
      }),
    );
    const { executeTool } = await import("../src/backends/openai.js");

    const out = await executeTool(ctxFor(projectDir), "add_citation", { ref: "10.5555/3295222.3295349" });

    expect(out.isError).toBe(false);
    expect(out.content).toContain("Added to");
    expect(out.content).toMatch(/skipped/i);
    expect(existsSync(join(projectDir, "references.bib")) || existsSync(join(projectDir, "refs.bib"))).toBe(true);
  });

  it("audit_citations runs from the tool layer and reports per-entry verdicts", async () => {
    writeBib(`${ATTENTION}\n\n${FABRICATED}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith("https://api.crossref.org/works/")) return crossrefWork("Attention Is All You Need");
        if (isTitleSearch(u)) return emptyTitleSearch();
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const { executeTool } = await import("../src/backends/openai.js");

    const out = await executeTool(ctxFor(projectDir), "audit_citations", {});

    expect(out.isError).toBe(false);
    expect(out.content).toContain("1 verified");
    expect(out.content).toContain("UNRESOLVED \\cite{ghost2019quantum}");
  });

  it("audit_citations accepts a targeted key list from the model", async () => {
    writeBib(`${ATTENTION}\n\n${FABRICATED}`);
    vi.stubGlobal("fetch", vi.fn(async () => crossrefWork("Attention Is All You Need")));
    const { executeTool } = await import("../src/backends/openai.js");

    const out = await executeTool(ctxFor(projectDir), "audit_citations", { keys: ["vaswani2017attention"] });

    expect(out.content).toContain("Checked 1 entry");
    expect(out.content).not.toContain("ghost2019quantum");
  });
});

describe("both backends expose the verification tools", () => {
  it("advertises audit_citations in the shared tool catalog", async () => {
    const { AGENT_TOOL_INFO } = await import("../src/backends/types.js");
    const names = AGENT_TOOL_INFO.map((t) => t.name);
    expect(names).toContain("audit_citations");
  });

  it("keeps audit_citations available in read-only modes (it only reads)", async () => {
    const { toolDefinitions } = await import("../src/backends/openai.js");
    const readOnly = toolDefinitions(true).map((t: any) => t.function.name);
    expect(readOnly).toContain("audit_citations");
    expect(readOnly).not.toContain("add_citation"); // writes — still blocked
  });

  it("maps the tool to a stable event name for the chat UI", async () => {
    const { eventToolName } = await import("../src/backends/openai.js");
    expect(eventToolName("audit_citations")).toBe("mcp__blattbot__audit_citations");
  });

  // verify_citation_support checks a paper's own content against a specific
  // claim — a different question from audit_citations' "is this a real
  // reference", but the same wiring properties: cataloged, read-only, stable
  // event name. Its actual judgment logic (PDF/abstract fallback, verdict
  // parsing) is covered in papers.test.ts via dependency-injected judges —
  // it always ends in a one-shot LLM call, which isn't mockable through
  // executeTool the way audit_citations' pure HTTP lookups are above.
  it("advertises verify_citation_support in the shared tool catalog", async () => {
    const { AGENT_TOOL_INFO } = await import("../src/backends/types.js");
    const names = AGENT_TOOL_INFO.map((t) => t.name);
    expect(names).toContain("verify_citation_support");
  });

  it("keeps verify_citation_support available in read-only modes (it only reads)", async () => {
    const { toolDefinitions } = await import("../src/backends/openai.js");
    const readOnly = toolDefinitions(true).map((t: any) => t.function.name);
    expect(readOnly).toContain("verify_citation_support");
  });

  it("maps verify_citation_support to a stable event name for the chat UI", async () => {
    const { eventToolName } = await import("../src/backends/openai.js");
    expect(eventToolName("verify_citation_support")).toBe("mcp__blattbot__verify_citation_support");
  });
});
