import { load } from "cheerio";
import type { BibEntry } from "./bib.js";
import { loadSettings } from "./settings.js";
import { normalizedDoi, normalizedTitle, publicSourceUrl, type WebPaperText } from "./paper-metadata.js";

export interface PaperDiscovery {
  urls: string[];
  text?: WebPaperText;
  warnings: string[];
}
const uniqueUrls = (values: unknown[]) => [...new Set(values.map(value => publicSourceUrl(value)).filter((value): value is string => !!value))];

/** Search results are candidate addresses only, never source evidence. */
export function webResultUrls(html: string): string[] {
  const $ = load(html);
  if ($("#challenge-form, #anomaly-modal, .anomaly-modal").length || /Unfortunately, bots use DuckDuckGo too/i.test($.text()))
    throw new Error("Public web search requires an interactive challenge; automatic discovery is unavailable");
  const links = $("a.result__a, a.result-link").toArray().map(node => {
    const href = $(node).attr("href");
    const url = publicSourceUrl(href, "https://duckduckgo.com");
    if (!url) return;
    const target = new URL(url);
    return target.hostname.endsWith("duckduckgo.com") ? target.searchParams.get("uddg") : url;
  });
  if (!links.length && !/no results (?:found|for)/i.test($.text()))
    throw new Error("Public web search returned an unrecognized page; discovery coverage is unknown");
  return uniqueUrls(links).slice(0, 6);
}

export async function discoverPaperSources(entry: Pick<BibEntry, "fields" | "type">, signal: AbortSignal): Promise<PaperDiscovery> {
  const result: PaperDiscovery = { urls: [], warnings: [] };
  const title = entry.fields.title?.replace(/[{}]/g, "").trim();
  if (!title) return result;
  const doi = normalizedDoi(entry.fields.doi);
  const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
  // Crossref is independent of Semantic Scholar and may carry full-text links,
  // publisher abstracts, or the correct publisher address for a stale DOI URL.
  try {
    const url = doi ? `https://api.crossref.org/works/${encodeURIComponent(doi)}`
      : `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=3`;
    const response = await request(url);
    if (!response.ok) throw new Error(`Crossref source lookup returned HTTP ${response.status}`);
    const data = await response.json() as any;
    const records = doi ? [data.message] : data.message?.items ?? [];
    const work = records.find((row: any) => row && normalizedTitle(row.title?.[0] ?? "") === normalizedTitle(title) && (!doi || normalizedDoi(row.DOI) === doi));
    if (work) {
      result.urls.push(...uniqueUrls([work.resource?.primary?.URL, work.URL, ...(work.link ?? []).filter((link: any) => link["content-type"] === "application/pdf").map((link: any) => link.URL)]));
      if (typeof work.abstract === "string") {
        const text = load(work.abstract, { xml: true }).text().trim();
        if (text.length >= 80 && text.length <= 40000) result.text = { basis: "abstract", title, text, url: `https://doi.org/${work.DOI}`, retrievedAt: new Date().toISOString() };
      }
    }
  } catch (error: any) { signal.throwIfAborted(); result.warnings.push(error.message); }
  try {
    const key = loadSettings().braveSearchApiKey.trim();
    const query = `"${title.replace(/"/g, "").slice(0, 450)}" PDF`;
    if (key) {
      const response = await request(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`, { headers: { "X-Subscription-Token": key, Accept: "application/json" } });
      if (!response.ok) throw new Error(`Web search returned HTTP ${response.status}${[401, 403].includes(response.status) ? "; check the Brave Search key in Settings" : ""}`);
      const data = await response.json() as any;
      result.urls.push(...uniqueUrls((data.web?.results ?? []).map((row: any) => row.url)).slice(0, 6));
    } else {
      const response = await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`Public web search returned HTTP ${response.status}; an optional Brave Search key provides another discovery route`);
      result.urls.push(...webResultUrls(await response.text()));
    }
  } catch (error: any) { signal.throwIfAborted(); result.warnings.push(error.message); }
  result.urls = uniqueUrls(result.urls).slice(0, 8);
  return result;
}
