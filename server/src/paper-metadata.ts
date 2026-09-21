import { load } from "cheerio";
import type { BibEntry } from "./bib.js";

export interface WebPaperText {
  basis: "abstract" | "summary";
  title: string;
  text: string;
  url: string;
  retrievedAt: string;
}
export const normalizedTitle = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const normalizedDoi = (text = "") => text.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();

/** A page title or reference-list mention is not sufficient identity evidence. */
export function publisherText(html: string, url: string, entry: Pick<BibEntry, "fields" | "type">): WebPaperText | undefined {
  const $ = load(html);
  const meta = (name: string) => $(`meta[name="${name}"], meta[property="${name}"]`).first().attr("content")?.trim() ?? "";
  const doi = normalizedDoi(meta("citation_doi") || meta("dc.identifier"));
  const expectedDoi = normalizedDoi(entry.fields.doi);
  const title = meta("citation_title") || meta("dc.title") || meta("DC.Title") || meta("og:title");
  const parent = meta("citation_book_title");
  const book = /^(book|collection|proceedings)$/i.test(entry.type);
  const chapter = book && !!expectedDoi && doi.startsWith(expectedDoi + ".");
  const exactTitle = normalizedTitle(title) === normalizedTitle(entry.fields.title ?? "");
  const parentTitle = book && normalizedTitle(parent) === normalizedTitle(entry.fields.title ?? "");
  if (expectedDoi && doi && doi !== expectedDoi && !chapter) return;
  if (!(expectedDoi && doi === expectedDoi) && !chapter && !exactTitle && !parentTitle) return;
  if (!title || !entry.fields.title) return;
  $("script, style, nav, footer, .references, #references").remove();
  const explicit = meta("citation_abstract");
  const section = $(".abstract, #abstract, [role='doc-abstract'], .abstract-content, .summary").filter((_, node) => {
    return !$(node).parents(".related, .recommendations, .references, #references").length;
  }).first();
  section.find("h2, h3, h4").remove();
  // Paragraph boundaries matter, including for accurate quotations later.
  section.find("p, div, br").append("\n");
  const text = (explicit || section.text()).replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
  if (text.length < 80 || text.length > 40000 || /summary is not available|abstract is not available/i.test(text)) return;
  const basis = chapter || book || section.hasClass("summary") ? "summary" : "abstract";
  return { basis, title, text, url, retrievedAt: new Date().toISOString() };
}

export function publicSourceUrl(raw: unknown, base?: string): string | undefined {
  if (typeof raw !== "string" || raw.length > 8000) return;
  try {
    const url = new URL(raw, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    url.hash = "";
    return url.href;
  } catch { return; }
}
