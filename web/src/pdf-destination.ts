import type { PDFDocumentProxy } from "pdfjs-dist";

export interface PdfDestination {
  page: number;
  /** Viewport coordinates divided by page width, so they survive zoom changes. */
  offset: number;
  left: number;
}

/** Resolve PDF links/bookmarks, including named destinations and rotated pages. */
export async function resolvePdfDestination(doc: PDFDocumentProxy, destination: unknown): Promise<PdfDestination | null> {
  try {
    const dest = typeof destination === "string" ? await doc.getDestination(destination) : destination;
    if (!Array.isArray(dest) || dest.length < 2) return null;
    const index = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
    if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) return null;
    const page = await doc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const kind = dest[1]?.name;
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    let point = [0, 0];
    if (kind === "XYZ" || kind === "FitH" || kind === "FitBH" || kind === "FitV" || kind === "FitBV") {
      const x = kind === "XYZ" || kind === "FitV" || kind === "FitBV" ? dest[2] : null;
      const y = kind === "XYZ" ? dest[3] : kind === "FitH" || kind === "FitBH" ? dest[2] : null;
      if (finite(x) || finite(y)) point = viewport.convertToViewportPoint(finite(x) ? x : page.view[0], finite(y) ? y : page.view[3]);
    } else if (kind === "FitR" && dest.slice(2, 6).length === 4 && dest.slice(2, 6).every(finite)) {
      const a = viewport.convertToViewportPoint(dest[2], dest[3]);
      const b = viewport.convertToViewportPoint(dest[4], dest[5]);
      point = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
    } else if (kind !== "Fit" && kind !== "FitB") return null;
    return { page: index + 1,
      offset: Math.max(0, Math.min(viewport.height, point[1])) / viewport.width,
      left: Math.max(0, Math.min(viewport.width, point[0])) / viewport.width };
  } catch { return null; }
}
