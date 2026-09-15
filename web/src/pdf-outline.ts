import type { PDFDocumentProxy } from "pdfjs-dist";

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
        const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest)) {
          const index = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
          if (Number.isInteger(index) && index >= 0 && index < doc.numPages) {
            const page = await doc.getPage(index + 1);
            const viewport = page.getViewport({ scale: 1 });
            const kind = dest[1]?.name;
            const y = kind === "XYZ" ? dest[3] : kind === "FitH" || kind === "FitBH" ? dest[2] : null;
            const x = kind === "XYZ" && typeof dest[2] === "number" ? dest[2] : page.view[0];
            const offset = typeof y === "number"
              ? Math.max(0, Math.min(viewport.height, viewport.convertToViewportPoint(x, y)[1])) / viewport.width
              : 0;
            sections.push({ title: item.title || "Untitled section", depth, page: index + 1, offset });
          }
        }
      } catch {
        // A broken or external bookmark must not hide valid child sections.
      }
      await visit(item.items ?? [], depth + 1);
    }
  }
  await visit(outline ?? [], 0);
  return sections;
}
