import { expect, it, vi } from "vitest";
import { relocatePdfReadingPosition } from "../../web/src/pdf-reading-anchor.js";
type PDFDocumentProxy = Parameters<typeof relocatePdfReadingPosition>[0];

function document(pages: { text: string; y: number }[], fingerprint: string) {
  return {
    fingerprints: [fingerprint], numPages: pages.length,
    getPage: vi.fn(async (n: number) => ({
      getViewport: () => ({ width: 600, convertToViewportPoint: (x: number, y: number) => [x, 800 - y] }),
      getTextContent: async () => ({ items: [{ str: pages[n - 1].text, transform: [1, 0, 0, 1, 40, pages[n - 1].y] }] }),
    })),
  } as unknown as PDFDocumentProxy;
}
const passage = "This paragraph should remain in view after editing.";

it("keeps the passage at the same viewport offset when it moves to another page", async () => {
  const before = document([{ text: passage, y: 600 }], "before");
  const after = document([{ text: "New introductory material", y: 700 }, { text: passage, y: 500 }], "after");
  const position = await relocatePdfReadingPosition(before, after, { page: 1, offset: 0.25 });
  expect(position.page).toBe(2);
  expect(position.offset).toBeCloseTo(0.25 + 100 / 600);
});

it("retains the page bookmark when the passage was deleted or navigation interrupted the search", async () => {
  const before = document([{ text: passage, y: 600 }], "before");
  const after = document([{ text: "Completely replacement text", y: 700 }], "after");
  const position = { page: 1, offset: 0.25 };
  expect(await relocatePdfReadingPosition(before, after, position)).toEqual(position);
  expect(await relocatePdfReadingPosition(before, after, position, () => true)).toEqual(position);
});

it("avoids reading document text for an unchanged PDF", async () => {
  const doc = document([{ text: passage, y: 600 }], "same");
  expect(await relocatePdfReadingPosition(doc, doc, { page: 1, offset: 0.25 })).toEqual({ page: 1, offset: 0.25 });
  expect(doc.getPage).not.toHaveBeenCalled();
});
