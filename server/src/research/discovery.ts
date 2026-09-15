import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readAllBibEntries,
  searchPapers,
  type PaperHit,
} from "../citations.js";
import { entryDoi } from "../bib.js";
import { titlesSimilar } from "../papers.js";
import { bibHash } from "./evidence.js";
import { now, readStore, updateStore } from "./store.js";
import { openAlexHeaders } from "../research-providers.js";
import { SourceServiceError } from "./source-failure.js";

export interface SearchRun {
  id: string;
  at: string;
  kind: "search" | "references" | "citing";
  query: string;
  criteria: string;
  results: PaperHit[];
  total?: number;
  cursor?: string;
  error?: string;
  decisions: Record<
    string,
    { decision: "include" | "exclude" | "pending"; reason: string }
  >;
}
export function searchHistory(id: string): SearchRun[] {
  return readStore(id, "searches", []);
}
function record(id: string, run: SearchRun): SearchRun {
  updateStore<SearchRun[]>(id, "searches", [], (runs) =>
    [...runs, run].slice(-300),
  );
  return run;
}
export async function searchLiterature(
  id: string,
  query: string,
  limit = 10,
  criteria = "",
): Promise<SearchRun> {
  query = z.string().min(1).max(1000).parse(query);
  z.number().int().min(1).max(30).parse(limit);
  const run: SearchRun = {
    id: randomUUID(),
    at: now(),
    kind: "search",
    query,
    criteria: z.string().max(4000).parse(criteria),
    results: [],
    decisions: {},
  };
  try {
    run.results = await searchPapers(query, limit);
  } catch (error: any) {
    run.error = String(error.message ?? error);
  }
  return record(id, run);
}
export async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<any> {
  const auth = new URL(url).hostname === "api.openalex.org" ? openAlexHeaders() : {};
  let result: Response;
  try {
    result = await fetch(url, {
      headers: { ...auth, ...headers } as Record<string, string>,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000),
      redirect: "error",
    });
  } catch (error: any) {
    signal?.throwIfAborted();
    const code = error?.cause?.code;
    throw new Error(
      `Network request to ${new URL(url).hostname} failed${typeof code === "string" && /^[A-Z_0-9]+$/.test(code) ? ` (${code})` : ""}: ${error?.name === "TimeoutError" ? "timed out" : "fetch failed"}`,
    );
  }
  if (!result.ok) {
    const after = result.headers.get("retry-after");
    const reset = result.headers.get("x-ratelimit-reset");
    const retryTime = after
      ? /^\d+(\.\d+)?$/.test(after)
        ? Date.now() + Number(after) * 1000
        : Date.parse(after)
      : result.status === 429 &&
          result.headers.get("x-ratelimit-remaining") === "0" &&
          reset
        ? Date.now() + Number(reset) * 1000
        : NaN;
    throw new SourceServiceError(
      `Source service returned HTTP ${result.status}${result.status === 429 ? " (rate limited; retry later)" : ""}`,
      result.status,
      Number.isFinite(retryTime)
        ? new Date(retryTime).toISOString()
        : undefined,
    );
  }
  return result.json();
}
export async function openAlexWork(
  dir: string,
  key: string,
  signal?: AbortSignal,
): Promise<any> {
  const entry = readAllBibEntries(dir).find(
    (item) => item.entry.key === key,
  )?.entry;
  if (!entry) throw new Error("unknown citation key");
  if (
    readAllBibEntries(dir).filter((item) => item.entry.key === key).length > 1
  )
    throw new Error(
      "Duplicate citation key; resolve the bibliography ambiguity first.",
    );
  const doi = entryDoi(entry.fields);
  let data;
  try {
    data = doi
      ? await fetchJson(
          `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`,
          {},
          signal,
        )
      : (
          await fetchJson(
            `https://api.openalex.org/works?search=${encodeURIComponent(entry.fields.title ?? key)}&per-page=5`,
            {},
            signal,
          )
        ).results?.find((work: any) =>
          titlesSimilar(work.display_name ?? "", entry.fields.title ?? ""),
        );
  } catch (error) {
    if (!doi || !(error instanceof SourceServiceError) || error.status !== 404)
      throw error;
    const matches = await fetchJson(
      `https://api.openalex.org/works?search=${encodeURIComponent(entry.fields.title ?? key)}&per-page=5`,
      {},
      signal,
    );
    data = matches.results?.find((work: any) =>
      titlesSimilar(work.display_name ?? "", entry.fields.title ?? ""),
    );
  }
  if (!data?.id || !matchesOpenAlexIdentity(data, entry.fields, doi))
    throw new Error(
      "OpenAlex could not resolve this bibliography entry reliably",
    );
  return data;
}
function matchesOpenAlexIdentity(
  work: any,
  fields: Record<string, string>,
  doi?: string,
) {
  if (titlesSimilar(work.display_name ?? "", fields.title ?? "")) return true;
  // Some OpenAlex DOI records omit a subtitle (e.g. "Yago"). Accept a
  // matching main title only when DOI, publication year and author agree too.
  const normalize = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const main = normalize((fields.title ?? "").split(/[:—–]/)[0]);
  const indexed = normalize(work.display_name ?? "");
  const exactDoi =
    typeof work.doi === "string" &&
    work.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() ===
      doi?.toLowerCase();
  const year = Number(fields.year);
  const families = (fields.author ?? "")
    .split(/\s+and\s+/)
    .map((name) =>
      normalize(
        name.includes(",")
          ? name.split(",")[0]
          : (name.trim().split(/\s+/).at(-1) ?? ""),
      ),
    )
    .filter((name) => name.length > 2);
  const authorMatch = (work.authorships ?? []).some((a: any) => {
    const name = normalize(a.author?.display_name ?? "");
    return families.some(
      (family) => name === family || name.endsWith(` ${family}`),
    );
  });
  return (
    exactDoi &&
    main.length >= 4 &&
    main === indexed &&
    Number.isFinite(year) &&
    year > 1000 &&
    Math.abs(work.publication_year - year) <= 1 &&
    authorMatch
  );
}
function openAlexHit(work: any): PaperHit {
  const doi =
    typeof work.doi === "string"
      ? work.doi.replace(/^https?:\/\/doi.org\//, "")
      : undefined;
  return {
    ref: doi || `openalex:${String(work.id).split("/").pop()}`,
    doi,
    title: work.display_name || "Untitled",
    authors: (work.authorships ?? [])
      .map((a: any) => a.author?.display_name)
      .filter(Boolean)
      .join(", "),
    year: work.publication_year,
    venue: work.primary_location?.source?.display_name,
    citations: work.cited_by_count,
    source: "OpenAlex",
  };
}
export async function citationNeighbors(
  id: string,
  dir: string,
  key: string,
  direction: "references" | "citing",
  cursor?: string,
): Promise<SearchRun> {
  const run: SearchRun = {
    id: randomUUID(),
    at: now(),
    kind: direction,
    query: key,
    criteria:
      "Citation relationships from OpenAlex; indexed coverage may be incomplete.",
    results: [],
    decisions: {},
  };
  try {
    const work = await openAlexWork(dir, key);
    const workId = String(work.id).split("/").pop() ?? "";
    if (!/^W\d+$/.test(workId))
      throw new Error("invalid OpenAlex work identifier");
    if (direction === "references") {
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0)
        throw new Error("invalid reference cursor");
      const refs = (work.referenced_works ?? [])
        .map((ref: string) => ref.split("/").pop())
        .filter((ref: string) => /^W\d+$/.test(ref));
      run.total = refs.length;
      const slice = refs.slice(offset, offset + 50);
      if (slice.length)
        run.results = (
          (
            await fetchJson(
              `https://api.openalex.org/works?filter=openalex_id:${slice.join("|")}&per-page=50`,
            )
          ).results ?? []
        ).map(openAlexHit);
      if (offset + 50 < refs.length) run.cursor = String(offset + 50);
    } else {
      const data = await fetchJson(
        `https://api.openalex.org/works?filter=cites:${workId}&per-page=50&cursor=${encodeURIComponent(cursor ?? "*")}`,
      );
      run.results = (data.results ?? []).map(openAlexHit);
      run.total = data.meta?.count;
      if (run.results.length) run.cursor = data.meta?.next_cursor ?? undefined;
    }
  } catch (error: any) {
    run.error = String(error.message ?? error);
  }
  return record(id, run);
}
export function screeningDecision(
  id: string,
  runId: string,
  ref: string,
  decision: "include" | "exclude" | "pending",
  reason: string,
): SearchRun {
  let changed!: SearchRun;
  updateStore<SearchRun[]>(id, "searches", [], (runs) =>
    runs.map((run) => {
      if (run.id !== runId) return run;
      if (!run.results.some((hit) => hit.ref === ref))
        throw new Error("reference is not part of this search run");
      changed = {
        ...run,
        decisions: {
          ...run.decisions,
          [ref]: { decision, reason: z.string().max(4000).parse(reason) },
        },
      };
      return changed;
    }),
  );
  if (!changed) throw new Error("unknown search run");
  return changed;
}
export interface PublicationStatus {
  key: string;
  entryHash: string;
  at: string;
  status: "retracted" | "updated" | "not_flagged" | "unavailable";
  notices: { type: string; doi?: string; source?: string }[];
  note: string;
  stale?: boolean;
}
export function readPublicationStatuses(
  id: string,
  dir: string,
): Record<string, PublicationStatus> {
  return Object.fromEntries(
    Object.entries(
      readStore<Record<string, PublicationStatus>>(
        id,
        "publication-status",
        {},
      ),
    ).map(([key, status]) => [
      key,
      { ...status, stale: status.entryHash !== bibHash(dir, key) },
    ]),
  );
}
export async function publicationStatus(
  id: string,
  dir: string,
  key: string,
): Promise<PublicationStatus> {
  const entry = readAllBibEntries(dir).find(
    (item) => item.entry.key === key,
  )?.entry;
  if (!entry) throw new Error("unknown citation key");
  const doi = entryDoi(entry.fields);
  const result: PublicationStatus = {
    key,
    entryHash: bibHash(dir, key),
    at: now(),
    status: "unavailable",
    notices: [],
    note: "No DOI for a Crossref update check.",
  };
  const errors: string[] = [];
  let retracted = false;
  try {
    const work = await openAlexWork(dir, key);
    retracted = work.is_retracted === true;
    if (typeof work.is_retracted === "boolean") result.status = retracted ? "retracted" : "not_flagged";
  } catch {
    errors.push("OpenAlex unavailable or not reliably resolved.");
  }
  if (retracted)
    result.notices.push({ type: "retraction flag", source: "OpenAlex" });
  if (doi) {
    try {
      const work = (
        await fetchJson(
          `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        )
      ).message;
      if (
        !work?.title?.[0] ||
        !titlesSimilar(work.title.join(" "), entry.fields.title ?? "")
      )
        throw new Error(
          "Crossref title mismatch; status not attributed to this work",
        );
      // update-to lives on the NOTICE. Query notices targeting this DOI,
      // otherwise a retraction notice itself could be labeled retracted.
      const updates = (
        await fetchJson(
          `https://api.crossref.org/works?filter=updates:${encodeURIComponent(doi)}&rows=100`,
        )
      ).message;
      for (const notice of updates?.items ?? []) {
        for (const update of notice["update-to"] ?? []) {
          if (String(update.DOI ?? "").toLowerCase() !== doi.toLowerCase())
            continue;
          const type = String(update.type ?? "update");
          result.notices.push({
            type,
            doi: notice.DOI,
            source: update.source ?? "Crossref publisher",
          });
          if (/retract/i.test(type)) retracted = true;
        }
      }
      if ((updates?.["total-results"] ?? 0) > 100)
        errors.push("Only the first 100 update notices were retrieved.");
      result.status = retracted
        ? "retracted"
        : result.notices.length
          ? "updated"
          : "not_flagged";
    } catch (error: any) {
      errors.push(error.status === 404
        ? "Crossref does not index this DOI; publisher-notice coverage is incomplete."
        : `Crossref check incomplete: ${error.message}`);
    }
  }
  if (retracted) result.status = "retracted";
  result.note =
    `${errors.join(" ")} ${!doi ? "No DOI for Crossref lookup. " : ""}Checked indexed publisher/Retraction Watch notices through Crossref and available OpenAlex flags. No flag is not a guarantee that no correction or retraction exists; follow the publisher record.`.trim();
  if (result.entryHash !== bibHash(dir, key))
    throw new Error("Bibliography entry changed during status check; retry.");
  updateStore<Record<string, PublicationStatus>>(
    id,
    "publication-status",
    {},
    (all) => ({ ...all, [key]: result }),
  );
  return result;
}
