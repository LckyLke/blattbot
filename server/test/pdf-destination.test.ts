import { describe, expect, it, vi } from "vitest";
import { resolvePdfDestination } from "../../web/src/pdf-destination.js";

const fixture = () => ({
  numPages: 5,
  getDestination: vi.fn(async () => [{ num: 10, gen: 0 }, { name: "XYZ" }, 40, 400, null]),
  getPageIndex: vi.fn(async () => 3),
  getPage: vi.fn(async () => ({ view: [0, 0, 600, 800], getViewport: () => ({ width: 600, height: 800,
    convertToViewportPoint: (x: number, y: number) => [x, 800 - y] }) })),
});
const resolve = (doc: ReturnType<typeof fixture>, dest: unknown) => resolvePdfDestination(doc as any, dest);
describe("internal PDF reference destinations", () => {
  it("resolves named equation destinations to the actual page and position", async () => {
    const doc = fixture();
    expect(await resolve(doc, "equation.6")).toEqual({ page: 4, offset: 400 / 600, left: 40 / 600 });
    expect(doc.getDestination).toHaveBeenCalledWith("equation.6");
    expect(doc.getPageIndex).toHaveBeenCalledWith({ num: 10, gen: 0 });
  });
  it("handles explicit, same-page, fit, and rectangle destinations", async () => {
    const doc = fixture();
    expect(await resolve(doc, [0, { name: "XYZ" }, null, 700, null])).toEqual({ page: 1, offset: 100 / 600, left: 0 });
    expect(await resolve(doc, [0, { name: "FitH" }, 600])).toEqual({ page: 1, offset: 200 / 600, left: 0 });
    expect(await resolve(doc, [1, { name: "Fit" }])).toEqual({ page: 2, offset: 0, left: 0 });
    expect(await resolve(doc, [0, { name: "FitR" }, 100, 200, 400, 500])).toEqual({ page: 1, offset: 300 / 600, left: 100 / 600 });
    expect(await resolve(doc, [0, { name: "XYZ" }, null, null, null])).toEqual({ page: 1, offset: 0, left: 0 });
  });
  it("uses viewport transforms for rotated pages", async () => {
    const doc = fixture();
    doc.getPage.mockResolvedValue({ view: [0, 0, 600, 800], getViewport: () => ({ width: 800, height: 600,
      convertToViewportPoint: (x: number, y: number) => [y, x] }) });
    expect(await resolve(doc, [2, { name: "XYZ" }, 120, 700, null])).toEqual({ page: 3, offset: 120 / 800, left: 700 / 800 });
  });
  it("rejects missing and malformed destinations without navigating elsewhere", async () => {
    const doc = fixture();
    for (const dest of [null, [], [99, { name: "Fit" }], [-1, { name: "Fit" }], [0, { name: "Unknown" }], [0, { name: "FitR" }, 1]]) {
      expect(await resolve(doc, dest)).toBeNull();
    }
    doc.getDestination.mockRejectedValue(new Error("No such destination"));
    expect(await resolve(doc, "missing")).toBeNull();
  });
});
