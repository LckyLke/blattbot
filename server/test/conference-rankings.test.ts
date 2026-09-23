import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let root: string;
const edition = "ICORE2026", checkedAt = "2026-09-23T09:00:00Z";
const csv = [
  '1121,International Conference on Machine Learning,ICML,ICORE2026,A*,Yes,4611,,',
  '1122,International Conference on Machine Learning and Applications,ICMLA,ICORE2026,C,No,4611,,',
  '98,Advances in Neural Information Processing Systems (was NIPS),NeurIPS,ICORE2026,A*,Yes,4611,,',
  '2354,"AAAI/ACM Conference on AI, Ethics, and Society",AIES,ICORE2026,C,Yes,4608,4602,4611',
].join('\r\n');
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "blattbot-core-")); vi.stubEnv("BLATTBOT_DATA_DIR", root); vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
const provider = () => {
  const fetcher = vi.fn(async (url: string) => new Response(url.includes("do=Export") ? csv : '<select name="source"><option value="all">All</option><option value="CORE2023">2023</option><option value="ICORE2026">2026</option></select>'));
  vi.stubGlobal("fetch", fetcher); return fetcher;
};
describe("official conference rankings", () => {
  it("parses official CSV with quoted commas and rejects truncated exports or wrong editions", async () => {
    const { parseConferenceRankings } = await import("../src/conference-rankings.js");
    const records = parseConferenceRankings(csv, edition, checkedAt);
    expect(records).toHaveLength(4);
    expect(records[3].title).toBe("AAAI/ACM Conference on AI, Ethics, and Society");
    expect(records[0]).toMatchObject({ rank: "A*", edition, checkedAt, url: "https://portal.core.edu.au/conf-ranks/1121/" });
    expect(parseConferenceRankings(csv, "CORE2023", checkedAt)).toEqual([]);
    expect(parseConferenceRankings(csv + '\n"broken', edition, checkedAt)).toEqual([]);
  });
  it("matches exact names/acronyms and common proceedings formatting, without rating workshops or similar venues", async () => {
    const { parseConferenceRankings, matchConferenceRanking } = await import("../src/conference-rankings.js");
    const records = parseConferenceRankings(csv, edition, checkedAt);
    for (const venue of ["ICML", "ICML 2025", "Proceedings of the 42nd International Conference on Machine Learning", "International Conference on Machine Learning (ICML)"])
      expect(matchConferenceRanking(venue, records)?.rank).toBe("A*");
    expect(matchConferenceRanking("Advances in Neural Information Processing Systems", records)?.acronym).toBe("NeurIPS");
    expect(matchConferenceRanking("ICML Workshops", records)).toBeUndefined();
    expect(matchConferenceRanking("International Conference on Machine Learning and Cybernetics", records)).toBeUndefined();
    expect(matchConferenceRanking("ICMLA", records)?.rank).toBe("C");
    expect(matchConferenceRanking("ICML", [...records, { ...records[1], acronym: "ICML" }])).toBeUndefined();
  });
  it("discovers the latest edition, shares concurrent downloads, and persists the cache", async () => {
    const fetcher = provider();
    let rankings = await import("../src/conference-rankings.js");
    const [a, b] = await Promise.all([rankings.resolveConferenceRanking("ICML"), rankings.resolveConferenceRanking("NeurIPS")]);
    expect(a?.rank).toBe("A*"); expect(b?.rank).toBe("A*");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toContain("source=ICORE2026");
    vi.resetModules(); rankings = await import("../src/conference-rankings.js");
    expect((await rankings.resolveConferenceRanking("ICML"))?.edition).toBe(edition);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("skips journals and retains the dated cached edition during outages", async () => {
    const fetcher = provider();
    let rankings = await import("../src/conference-rankings.js");
    expect(await rankings.resolveConferenceRanking("ICML", "journal")).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    await rankings.resolveConferenceRanking("ICML");
    const path = join(root, "conference-rankings.json");
    const old = JSON.parse(readFileSync(path, "utf8")); old.checkedAt = "2020-01-01T00:00:00Z";
    writeFileSync(path, JSON.stringify(old));
    vi.resetModules(); rankings = await import("../src/conference-rankings.js");
    const offline = vi.fn(async () => { throw new Error("offline"); }); vi.stubGlobal("fetch", offline);
    expect((await rankings.resolveConferenceRanking("ICML"))?.edition).toBe(edition);
    expect((await rankings.resolveConferenceRanking("ICMLA"))?.rank).toBe("C");
    expect(offline).toHaveBeenCalledTimes(1);
  });
  it("backs off a failed initial download without inventing a rating", async () => {
    const offline = vi.fn(async () => new Response("unavailable", { status: 503 })); vi.stubGlobal("fetch", offline);
    const { resolveConferenceRanking } = await import("../src/conference-rankings.js");
    expect(await resolveConferenceRanking("ICML")).toBeUndefined();
    expect(await resolveConferenceRanking("NeurIPS")).toBeUndefined();
    expect(offline).toHaveBeenCalledTimes(1);
  });
});
