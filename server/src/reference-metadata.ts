import { createHash } from "node:crypto";
import type { BibEntry } from "./bib.js";
import { resolveConferenceRanking, type ConferenceRanking } from "./conference-rankings.js";
import { readPaperStore, resolveOpenAlexPaper, resolveS2Paper, titlesSimilar, writePaperRecord, type PaperStore } from "./papers.js";

type Source = "Semantic Scholar" | "OpenAlex";
export interface ReferenceMetadata {
  conferenceRanking?: ConferenceRanking;
  citationCount?: number;
  citationSource?: Source;
  citationUrl?: string;
  citationUpdatedAt?: string;
  venue?: string;
  venueType?: "conference" | "journal" | "venue";
  venueSource?: Source | "BibTeX";
}

const fingerprint = (entry: BibEntry) => createHash("sha256").update(JSON.stringify([entry.type, Object.entries(entry.fields).sort()])).digest("hex");
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const venueName = (value?: string | null) => {
  const name = value?.replace(/[{}]/g, "").trim();
  return name && !/\b(arxiv|biorxiv|medrxiv|ssrn|corr|preprint)\b/i.test(name) ? name : undefined;
};
const venueType = (value?: string): ReferenceMetadata["venueType"] => value === "conference" || value === "journal" ? value : "venue";

function bibliographyVenue(entry: BibEntry): ReferenceMetadata {
  const booktitle = venueName(entry.fields.booktitle);
  const journal = venueName(entry.fields.journal ?? entry.fields.journaltitle);
  if (booktitle) return { venue: booktitle, venueType: /^(inproceedings|conference|proceedings)$/.test(entry.type) ? "conference" : "venue", venueSource: "BibTeX" };
  return journal ? { venue: journal, venueType: "journal", venueSource: "BibTeX" } : {};
}

/** Local fields and cached metadata are available without waiting for a provider. */
export function cachedReferenceMetadata(projectId: string, entry: BibEntry, store: PaperStore = readPaperStore(projectId)) {
  const saved = store[entry.key]?.referenceMetadata;
  const matches = saved?.fingerprint === fingerprint(entry);
  return {
    metadata: { ...(matches ? saved.value : {}), ...bibliographyVenue(entry) },
    metadataNeedsRefresh: !matches || saved.retryAt <= Date.now() || saved.version !== 2,
  };
}

const inFlight = new Map<string, Promise<ReferenceMetadata>>();

/** Reuse provider pacing, deduplicate concurrent requests, and cache per entry. */
export async function getReferenceMetadata(projectId: string, entry: BibEntry): Promise<ReferenceMetadata> {
  const cached = cachedReferenceMetadata(projectId, entry);
  if (!cached.metadataNeedsRefresh) return cached.metadata;
  const hash = fingerprint(entry);
  const key = `${projectId}:${entry.key}:${hash}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    const result = { ...cached.metadata };
    const title = entry.fields.title?.replace(/[{}]/g, "").trim();
    // Even identifier lookups must not enrich a reference with a different title.
    const matches = (paper: { title?: string } | null) => paper && (!title || (paper.title && titlesSimilar(title, paper.title)));
    const s2 = await resolveS2Paper(entry).catch(() => null);
    let foundCount = false;
    if (matches(s2)) {
      if (count(s2!.citationCount)) {
        Object.assign(result, { citationCount: s2!.citationCount, citationSource: "Semantic Scholar", citationUrl: s2!.url, citationUpdatedAt: new Date().toISOString() });
        foundCount = true;
      }
      const venue = venueName(s2!.publicationVenue?.name) ?? venueName(s2!.venue);
      if (!result.venue && venue) Object.assign(result, { venue, venueType: venueType(s2!.publicationVenue?.type), venueSource: "Semantic Scholar" });
    }
    if (!foundCount || !result.venue) {
      const oa = await resolveOpenAlexPaper(entry).catch(() => null);
      if (matches(oa)) {
        if (!foundCount && count(oa!.citationCount)) {
          Object.assign(result, { citationCount: oa!.citationCount, citationSource: "OpenAlex", citationUrl: oa!.url, citationUpdatedAt: new Date().toISOString() });
          foundCount = true;
        }
        const venue = venueName(oa!.venue);
        if (!result.venue && venue) Object.assign(result, { venue, venueType: venueType(oa!.venueType), venueSource: "OpenAlex" });
      }
    }
    result.conferenceRanking = await resolveConferenceRanking(result.venue, result.venueType).catch(() => undefined);
    // Preserve old values during outages, with their original observation date.
    const ttl = foundCount && result.venue ? 24 * 60 * 60_000 : 15 * 60_000;
    writePaperRecord(projectId, entry.key, { referenceMetadata: { version: 2, fingerprint: hash, value: result, retryAt: Date.now() + ttl } });
    return result;
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}
