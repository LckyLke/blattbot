import { describe, expect, it, vi } from "vitest";
import { readPdfSections } from "../../web/src/pdf-outline.js";
type PDFDocumentProxy = Parameters<typeof readPdfSections>[0];

describe("PDF section destinations", () => {
  it("resolves named and explicit headings on the same page, preserving nesting", async () => {
    const doc = {
      numPages: 2,
      getOutline: async () => [{ title: "Introduction", dest: "intro", items: [
        { title: "Motivation", dest: [0, { name: "FitH" }, 400], items: [] },
      ] }],
      getDestination: vi.fn(async () => [{ num: 7, gen: 0 }, { name: "XYZ" }, null, 700, null]),
      getPageIndex: vi.fn(async () => 0),
      getPage: async () => ({ view: [0, 0, 600, 800], getViewport: () => ({
        width: 600, height: 800, convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
      }) }),
    };
    expect(await readPdfSections(doc as unknown as PDFDocumentProxy)).toEqual([
      { title: "Introduction", depth: 0, page: 1, offset: 100 / 600 },
      { title: "Motivation", depth: 1, page: 1, offset: 400 / 600 },
    ]);
    expect(doc.getDestination).toHaveBeenCalledWith("intro");
    expect(doc.getPageIndex).toHaveBeenCalledWith({ num: 7, gen: 0 });
  });

  it("keeps valid children of broken bookmarks and ignores external links", async () => {
    const doc = {
      numPages: 1,
      getOutline: async () => [
        { title: "Broken", dest: "missing", items: [{ title: "Valid", dest: [0, { name: "Fit" }], items: [] }] },
        { title: "Website", dest: null, url: "https://example.com", items: [] },
        { title: "Out of range", dest: [9, { name: "Fit" }], items: [] },
      ],
      getDestination: async () => { throw new Error("Missing destination"); },
      getPage: async () => ({ view: [0, 0, 600, 800], getViewport: () => ({ width: 600, height: 800 }) }),
    };
    expect(await readPdfSections(doc as unknown as PDFDocumentProxy)).toEqual([
      { title: "Valid", depth: 1, page: 1, offset: 0 },
    ]);
    expect(await readPdfSections({ getOutline: async () => null } as unknown as PDFDocumentProxy)).toEqual([]);
  });
});
