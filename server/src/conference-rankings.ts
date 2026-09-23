/** Official CORE/ICORE conference export, shared across all project lookups. */
import { load } from "cheerio";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

export interface ConferenceRanking {
  rank: string;
  edition: string;
  title: string;
  acronym: string;
  url: string;
  checkedAt: string;
}
interface Catalog { edition: string; checkedAt: string; records: ConferenceRanking[] }
const PORTAL = "https://portal.core.edu.au/conf-ranks/";
const WEEK = 7 * 24 * 60 * 60_000;
const cachePath = () => join(DATA_DIR, "conference-rankings.json");
let saved: Catalog | undefined;
let loaded = false;
let retryAt = 0;
let pending: Promise<Catalog | undefined> | undefined;

/** The official export has no header and may quote commas/newlines in titles. */
export function parseConferenceRankings(csv: string, edition: string, checkedAt: string): ConferenceRanking[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(field.trim()); field = "";
      if (char === "\n") { rows.push(row); row = []; }
    } else field += char;
  }
  if (quoted) return [];
  if (field || row.length) rows.push([...row, field.trim()]);
  return rows.flatMap(([id, title, acronym, source, rank]) =>
    /^\d+$/.test(id) && title && source === edition && rank && rank.length < 80
      ? [{ rank, edition, title, acronym, url: `${PORTAL}${id}/`, checkedAt }] : []);
}

const normalized = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/&/g, " and ").replace(/[{}]/g, "")
  .replace(/\b(?:19|20)\d{2}\b|\b\d+(?:st|nd|rd|th)\b/g, " ")
  .replace(/^\s*(?:proceedings\s+of\s+)?(?:the\s+)?/i, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");

/** Exact normalized names/acronyms only; never infer rank from a substring. */
export function matchConferenceRanking(venue: string, records: ConferenceRanking[]): ConferenceRanking | undefined {
  const name = normalized(venue);
  if (!name) return undefined;
  const matches = records.filter(record => {
    const title = normalized(record.title);
    // The catalog annotates some official names with historical names.
    const currentTitle = normalized(record.title.replace(/\s*\((?:was|formerly|previously)[^)]*\)/gi, ""));
    const acronym = normalized(record.acronym);
    if ([title, currentTitle, acronym].filter(Boolean).includes(name)) return true;
    // Full names with their acronym in parentheses are common in BibTeX.
    return !!acronym && [title, currentTitle].some(full => name === `${full} ${acronym}` || name === `${acronym} ${full}`);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error(`Conference rankings HTTP ${response.status}`);
  if (Number(response.headers?.get("content-length")) > 2_000_000) throw new Error("Conference ranking export too large");
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("Conference ranking export too large");
  return text;
}

async function catalog(): Promise<Catalog | undefined> {
  if (!loaded) {
    loaded = true;
    try {
      const stored = JSON.parse(readFileSync(cachePath(), "utf8")) as Catalog;
      if (/^I?CORE\d{4}$/.test(stored.edition) && Number.isFinite(Date.parse(stored.checkedAt)) && Array.isArray(stored.records) && stored.records.length) saved = stored;
    } catch { /* The first lookup downloads the official export. */ }
  }
  if (saved && Date.now() - Date.parse(saved.checkedAt) < WEEK) return saved;
  if (pending) return pending;
  if (retryAt > Date.now()) return saved;
  pending = (async () => {
    try {
      const $ = load(await fetchText(PORTAL));
      const editions = $("select[name=source] option").map((_, option) => $(option).attr("value") ?? "").get()
        .filter(value => /^I?CORE\d{4}$/.test(value)).sort((a, b) => Number(b.slice(-4)) - Number(a.slice(-4)));
      const edition = editions[0];
      if (!edition) throw new Error("No CORE edition found");
      const url = new URL(PORTAL);
      url.search = new URLSearchParams({ search: "", by: "all", source: edition, sort: "atitle", do: "Export" }).toString();
      const checkedAt = new Date().toISOString();
      const records = parseConferenceRankings(await fetchText(url.href), edition, checkedAt);
      if (!records.length) throw new Error("Empty CORE export");
      saved = { edition, checkedAt, records };
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(`${cachePath()}.tmp`, JSON.stringify(saved));
      renameSync(`${cachePath()}.tmp`, cachePath());
    } catch {
      // Keep a dated, previously retrieved edition usable during outages.
      retryAt = Date.now() + 15 * 60_000;
    }
    return saved;
  })();
  try { return await pending; } finally { pending = undefined; }
}

export async function resolveConferenceRanking(venue?: string, venueType?: string): Promise<ConferenceRanking | undefined> {
  if (!venue || venueType === "journal") return undefined;
  const data = await catalog();
  return data ? matchConferenceRanking(venue, data.records) : undefined;
}
