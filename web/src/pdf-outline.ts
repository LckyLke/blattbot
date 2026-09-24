import type { PDFDocumentProxy } from "pdfjs-dist";
import { resolvePdfDestination } from "./pdf-destination.js";

export interface PdfSection {
  title: string;
  depth: number;
  page: number;
  /** Vertical destination in viewport units, divided by the viewport width. */
  offset: number;
}

export async function readPdfSections(doc: PDFDocumentProxy): Promise<PdfSection[]> {
  const sections: PdfSection[] = [];
  const outline = await doc.getOutline();
  async function visit(items: NonNullable<typeof outline>, depth: number): Promise<void> {
    for (const item of items) {
      try {
        const target = await resolvePdfDestination(doc, item.dest);
        if (target) sections.push({ title: item.title || "Untitled section", depth, page: target.page, offset: target.offset });
      } catch {
        // A broken or external bookmark must not hide valid child sections.
      }
      await visit(item.items ?? [], depth + 1);
    }
  }
  await visit(outline ?? [], 0);
  return sections;
}
