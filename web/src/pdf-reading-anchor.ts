import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api.js";
import { findPdfMatches } from "./pdf-search.js";

export interface PdfReadingLocation { page: number; offset: number }

/** Follow unchanged text through pagination changes, falling back to the saved page. */
export async function relocatePdfReadingPosition(
  before: PDFDocumentProxy, after: PDFDocumentProxy, position: PdfReadingLocation,
  cancelled: () => boolean = () => false,
): Promise<PdfReadingLocation> {
  if (before.fingerprints[0] === after.fingerprints[0]) return position;
  try {
    const previous = await before.getPage(Math.min(position.page, before.numPages));
    const viewport = previous.getViewport({ scale: 1 });
    const content = await previous.getTextContent();
    if (cancelled()) return position;
    const items = content.items.filter((item): item is TextItem => "str" in item);
    const baseline = (item: TextItem) => viewport.convertToViewportPoint(item.transform[4], item.transform[5])[1] / viewport.width;
    // A substantial text run close to the viewport top is a useful, fairly
    // distinctive anchor; don't anchor blank space to a distant paragraph.
    const candidates = items.filter(item => item.str.trim().length >= 16)
      .map(item => ({ item, distance: baseline(item) - position.offset }))
      .filter(candidate => candidate.distance >= -0.03 && candidate.distance < 0.5)
      .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
    const anchor = candidates[0];
    if (!anchor) return position;
    const query = anchor.item.str.trim().slice(0, 100);
    const pages = Array.from({ length: after.numPages }, (_, i) => i + 1)
      .sort((a, b) => Math.abs(a - position.page) - Math.abs(b - position.page));
    for (const pageNo of pages) {
      if (cancelled()) return position;
      const page = await after.getPage(pageNo);
      const text = await page.getTextContent();
      const runs = text.items.filter((item): item is TextItem => "str" in item);
      const hit = findPdfMatches(runs.map(item => item.str).join(" "), query, { limit: 1 }).hits[0];
      if (!hit) continue;
      let start = 0;
      const item = runs.find(run => {
        const contains = hit.start >= start && hit.start < start + run.str.length;
        start += run.str.length + 1;
        return contains;
      });
      if (!item) continue;
      const view = page.getViewport({ scale: 1 });
      return { page: pageNo, offset: view.convertToViewportPoint(item.transform[4], item.transform[5])[1] / view.width - anchor.distance };
    }
  } catch { /* A destroyed document or removed passage retains the geometric bookmark. */ }
  return position;
}
