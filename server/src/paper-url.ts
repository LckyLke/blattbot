import { decodeHtml, fetchPublicUrl } from "./read-url.js";
import { MAX_PDF_BYTES } from "./pdftext.js";
import { listPublisherAccess, publisherCookieForUrl } from "./publisher-access.js";

async function fetchPaperSource(url: string, signal: AbortSignal) {
  const connections = listPublisherAccess();
  try {
    return connections.length
      ? await fetchPublicUrl(url, signal, MAX_PDF_BYTES, { cookieForUrl: publisherCookieForUrl })
      : await fetchPublicUrl(url, signal, MAX_PDF_BYTES);
  } catch (error: any) {
    if (connections.some(connection => connection.origin === new URL(url).origin) && /HTTP (401|403)/.test(error.message))
      throw new Error(`${error.message} Saved university access did not retrieve this page. Reconnect in Settings → University access; the publisher may also require its API or a manual PDF download.`);
    throw error;
  }
}

/** Only follow advertised PDF links, never arbitrary pages or scripts. */
export function paperPdfLinks(html: string, base: string): string[] {
  const links = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const url = new URL(decodeHtml(raw), base);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
      // Book previews contain the book title but are not the cited full text.
      if (/excerpt|frontmatter|preview|sample|table.of.contents/i.test(url.pathname)) return;
      url.hash = "";
      links.add(url.href);
    } catch { /* Invalid advertised link. */ }
  };
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const match of clean.matchAll(/<(meta|link|a)\b([^>]*)>/gi)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
    const tag = match[1].toLowerCase();
    if (tag === "meta" && /^(citation_pdf_url|eprints.document_url)$/i.test(attrs.name ?? "")) add(attrs.content);
    else if ((tag === "link" || tag === "a") && (/application\/pdf/i.test(attrs.type ?? "") || /\.pdf(?:[?#]|$)/i.test(attrs.href ?? ""))) add(attrs.href);
  }
  return [...links].slice(0, 5);
}

/** Public, bounded downloads with the same redirect/private-network checks as read_url. */
export async function downloadPaperUrl(
  url: string,
  signal: AbortSignal,
  matches: (body: Buffer) => Promise<boolean>,
  onPage?: (html: string, url: string) => void,
): Promise<{ url: string; body: Buffer }> {
  const first = await fetchPaperSource(url, signal);
  const isPdf = (body: Buffer) => body.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf(first.body)) {
    if (/excerpt|frontmatter|preview|sample|table.of.contents/i.test(new URL(first.url).pathname))
      throw new Error("This URL identifies a preview or excerpt, not the cited full text");
    if (await matches(first.body)) { signal.throwIfAborted(); return first; }
    throw new Error("The supplied PDF could not be matched to the bibliography title or has no extractable text");
  }
  if (!/text\/html|application\/xhtml\+xml/i.test(first.type) && !/^\s*(?:<!doctype html|<html\b)/i.test(first.body.toString("utf8", 0, 200)))
    throw new Error("The supplied URL did not return a PDF or a paper landing page");
  const links = paperPdfLinks(first.body.toString("utf8"), first.url);
  onPage?.(first.body.toString("utf8"), first.url);
  for (const link of links) {
    if (link === first.url) continue;
    try {
      const pdf = await fetchPaperSource(link, signal);
      if (/excerpt|frontmatter|preview|sample|table.of.contents/i.test(new URL(pdf.url).pathname)) continue;
      if (isPdf(pdf.body) && await matches(pdf.body)) { signal.throwIfAborted(); return pdf; }
    } catch {
      signal.throwIfAborted();
      // A blocked or incorrect PDF must not hide another advertised copy.
    }
  }
  throw new Error("No readable PDF matching the bibliography title was retrieved from this page");
}
