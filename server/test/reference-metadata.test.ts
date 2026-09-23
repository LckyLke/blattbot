import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBib } from "../src/bib.js";
vi.mock("../src/conference-rankings.js", () => ({ resolveConferenceRanking: vi.fn(async () => undefined) }));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blattbot-ref-metadata-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const entry = (extra = "") => parseBib(`@inproceedings{alpha,title={Graph Models},doi={10.1234/alpha},${extra}}`)[0];
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
function providers(s2: unknown, oa: unknown, s2Status = 200) {
  const fetcher = vi.fn(async (url: string) => url.includes("semanticscholar") ? response(s2, s2Status) : response(oa));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("reference metadata", () => {
  it("shows bibliography venue without network access and preserves actual zero citations", async () => {
    const fetcher = providers({ title: "Graph Models", citationCount: 0, publicationVenue: { name: "Another conference", type: "conference" } }, null);
    const { cachedReferenceMetadata, getReferenceMetadata } = await import("../src/reference-metadata.js");
    const bib = entry("booktitle={The {Graph} Conference}");
    expect(cachedReferenceMetadata("p", bib).metadata).toEqual({ venue: "The Graph Conference", venueType: "conference", venueSource: "BibTeX" });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await getReferenceMetadata("p", bib);
    expect(result).toMatchObject({ citationCount: 0, citationSource: "Semantic Scholar", venue: "The Graph Conference" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("publicationVenue");
    expect(await getReferenceMetadata("p", bib)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back on rate limits and takes the published venue instead of an arXiv location", async () => {
    providers({}, {
      id: "https://openalex.org/W1", display_name: "Graph Models", cited_by_count: 42,
      primary_location: { source: { display_name: "arXiv", type: "repository" } },
      locations: [{ version: "publishedVersion", source: { display_name: "GraphConf", type: "conference" } }],
    }, 429);
    const { getReferenceMetadata } = await import("../src/reference-metadata.js");
    expect(await getReferenceMetadata("p", entry())).toMatchObject({ citationCount: 42, citationSource: "OpenAlex", citationUrl: "https://openalex.org/W1", venue: "GraphConf", venueType: "conference" });
  });

  it("does not invent zero counts or publication venues for preprints", async () => {
    providers({ title: "Graph Models", citationCount: null, venue: "arXiv" }, { display_name: "Graph Models", primary_location: { source: { display_name: "arXiv", type: "repository" } } });
    const { getReferenceMetadata } = await import("../src/reference-metadata.js");
    expect(await getReferenceMetadata("p", entry("journal={arXiv preprint arXiv:1234.56789}"))).toEqual({});
  });

  it("ignores metadata returned for a different paper", async () => {
    providers({ title: "Unrelated quantum physics", citationCount: 120, venue: "Nature" }, { display_name: "Another unrelated paper", cited_by_count: 300 });
    const { getReferenceMetadata } = await import("../src/reference-metadata.js");
    expect(await getReferenceMetadata("p", entry())).toEqual({});
  });

  it("deduplicates concurrent lookups and invalidates cache after bibliography edits", async () => {
    const fetcher = providers({ title: "Graph Models", citationCount: 12, publicationVenue: { name: "GraphConf", type: "conference" } }, null);
    const { cachedReferenceMetadata, getReferenceMetadata } = await import("../src/reference-metadata.js");
    const [a, b] = await Promise.all([getReferenceMetadata("p", entry()), getReferenceMetadata("p", entry())]);
    expect(a).toEqual(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cachedReferenceMetadata("p", entry()).metadataNeedsRefresh).toBe(false);
    const changed = entry();
    changed.fields.title = "Another paper";
    expect(cachedReferenceMetadata("p", changed)).toEqual({ metadata: {}, metadataNeedsRefresh: true });
  });

  it("preserves stale counts and their observation date during an outage", async () => {
    providers({ title: "Graph Models", citationCount: 12, venue: "GraphConf" }, null);
    const { getReferenceMetadata, cachedReferenceMetadata } = await import("../src/reference-metadata.js");
    const old = await getReferenceMetadata("p", entry());
    const { readPaperStore, writePaperRecord } = await import("../src/papers.js");
    const saved = readPaperStore("p").alpha.referenceMetadata!;
    writePaperRecord("p", "alpha", { referenceMetadata: { ...saved, retryAt: 0 } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    // Change settings so the provider's short-lived transport cache is not reused.
    const { saveSettings } = await import("../src/settings.js");
    saveSettings({ s2ApiKey: "offline-key" });
    expect(await getReferenceMetadata("p", entry())).toEqual(old);
    expect(cachedReferenceMetadata("p", entry()).metadataNeedsRefresh).toBe(false);
  });

  it("uses OpenAlex to fill a missing venue without replacing the Semantic Scholar count", async () => {
    providers({ title: "Graph Models", citationCount: 20 }, { display_name: "Graph Models", cited_by_count: 35, primary_location: { source: { display_name: "Graph Journal", type: "journal" } } });
    const { getReferenceMetadata } = await import("../src/reference-metadata.js");
    expect(await getReferenceMetadata("p", entry())).toMatchObject({ citationCount: 20, citationSource: "Semantic Scholar", venue: "Graph Journal", venueType: "journal", venueSource: "OpenAlex" });
  });
});
