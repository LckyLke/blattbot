import { describe, expect, it } from "vitest";
// The rendered-diff pixel math is a pure web module (no pdfjs, no DOM) —
// server tests import web sources directly, like diff.test.ts does.
import {
  CHANGED_PAGE_THRESHOLD,
  clusterBoxes,
  comparePage,
  diffPixels,
  pageChanged,
  type PixelGrid,
} from "../../web/src/pdfdiff.js";

/** A w×h RGBA grid filled with one gray value (opaque). */
function grid(w: number, h: number, value = 255): PixelGrid {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function setPixel(g: PixelGrid, x: number, y: number, value: number): void {
  const p = (y * g.width + x) * 4;
  g.data[p] = value;
  g.data[p + 1] = value;
  g.data[p + 2] = value;
}

function fillRect(g: PixelGrid, x: number, y: number, w: number, h: number, value: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) setPixel(g, xx, yy, value);
  }
}

describe("diffPixels", () => {
  it("identical grids differ nowhere", () => {
    const a = grid(20, 10);
    const b = grid(20, 10);
    const d = diffPixels(a, b);
    expect(d.count).toBe(0);
    expect(d.mask.every((v) => v === 0)).toBe(true);
  });

  it("sub-tolerance deltas are antialiasing noise, not differences", () => {
    const a = grid(20, 10, 200);
    const b = grid(20, 10, 200);
    setPixel(b, 3, 3, 208); // Δ8 = at the tolerance, not beyond
    expect(diffPixels(a, b).count).toBe(0);
    setPixel(b, 3, 3, 209); // Δ9 crosses it
    const d = diffPixels(a, b);
    expect(d.count).toBe(1);
    expect(d.mask[3 * 20 + 3]).toBe(1);
  });

  it("throws on mismatched dimensions", () => {
    expect(() => diffPixels(grid(4, 4), grid(5, 4))).toThrow(/same-size/);
  });
});

describe("pageChanged", () => {
  it("applies the 0.02% threshold", () => {
    // 100×100 = 10 000 px → threshold 2: strictly MORE than 2 changes a page.
    expect(10_000 * CHANGED_PAGE_THRESHOLD).toBe(2);
    expect(pageChanged(2, 100, 100)).toBe(false);
    expect(pageChanged(3, 100, 100)).toBe(true);
  });
});

describe("clusterBoxes", () => {
  const maskOf = (g: PixelGrid, base: PixelGrid) => diffPixels(base, g);

  it("one solid block becomes one tight box", () => {
    const base = grid(60, 40);
    const cur = grid(60, 40);
    fillRect(cur, 10, 5, 8, 6, 0);
    const { mask } = maskOf(cur, base);
    expect(clusterBoxes(mask, 60, 40)).toEqual([{ x: 10, y: 5, w: 8, h: 6 }]);
  });

  it("far-apart blocks stay separate; nearby ones merge across the gap", () => {
    const base = grid(120, 80);
    const cur = grid(120, 80);
    fillRect(cur, 5, 5, 4, 4, 0);
    fillRect(cur, 80, 60, 4, 4, 0); // far away → own box
    fillRect(cur, 12, 8, 4, 4, 0); // within the gap of the first → merges
    const boxes = clusterBoxes(maskOf(cur, base).mask, 120, 80);
    expect(boxes).toHaveLength(2);
    const sorted = [...boxes].sort((a, b) => a.x - b.x);
    expect(sorted[0]).toEqual({ x: 5, y: 5, w: 11, h: 7 }); // union of the two near blocks
    expect(sorted[1]).toEqual({ x: 80, y: 60, w: 4, h: 4 });
  });

  it("an L-shape grown from two directions collapses into one box", () => {
    const base = grid(100, 100);
    const cur = grid(100, 100);
    fillRect(cur, 10, 10, 30, 3, 0); // horizontal bar
    fillRect(cur, 10, 13, 3, 30, 0); // vertical bar off its left end
    const boxes = clusterBoxes(maskOf(cur, base).mask, 100, 100);
    expect(boxes).toEqual([{ x: 10, y: 10, w: 30, h: 33 }]);
  });

  it("empty mask yields no boxes", () => {
    expect(clusterBoxes(new Uint8Array(50 * 50), 50, 50)).toEqual([]);
  });
});

describe("comparePage", () => {
  it("unchanged page: not changed, no boxes", () => {
    const r = comparePage(grid(100, 100), grid(100, 100));
    expect(r.changed).toBe(false);
    expect(r.boxes).toEqual([]);
    expect(r.diffRatio).toBe(0);
  });

  it("a visible edit flags the page and boxes the region", () => {
    const a = grid(200, 150);
    const b = grid(200, 150);
    fillRect(b, 40, 30, 20, 10, 0);
    const r = comparePage(a, b);
    expect(r.changed).toBe(true);
    expect(r.diffRatio).toBeCloseTo((20 * 10) / (200 * 150), 10);
    expect(r.boxes).toEqual([{ x: 40, y: 30, w: 20, h: 10 }]);
  });

  it("a few noisy pixels stay below the changed threshold", () => {
    const a = grid(200, 150);
    const b = grid(200, 150);
    setPixel(b, 0, 0, 0); // 1 px of 30 000 → threshold is 6
    const r = comparePage(a, b);
    expect(r.changed).toBe(false);
  });

  it("resized pages count as one whole-page change", () => {
    const r = comparePage(grid(100, 100), grid(100, 120));
    expect(r.changed).toBe(true);
    expect(r.diffRatio).toBe(1);
    expect(r.boxes).toEqual([{ x: 0, y: 0, w: 100, h: 120 }]);
  });
});
