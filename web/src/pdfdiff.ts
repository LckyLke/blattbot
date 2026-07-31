/**
 * Pure pixel math behind the rendered PDF diff (Proof → "Rendered diff"):
 * compare two same-scale page rasters, classify pages as changed, and cluster
 * differing pixels into overlay boxes. No pdfjs and no DOM in here — the
 * functions take plain {width, height, data} grids so they unit-test in node
 * (the rendering side lives in components/RenderedDiff.tsx).
 */

/** Minimal ImageData shape (structural — ImageData satisfies it). */
export interface PixelGrid {
  width: number;
  height: number;
  /** RGBA bytes, 4 per pixel, row-major. */
  data: Uint8ClampedArray | Uint8Array;
}

/** An axis-aligned changed region, in the grid's pixel coordinates. */
export interface DiffBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Per-channel tolerance absorbing antialiasing noise between two renders. */
export const CHANNEL_TOLERANCE = 8;
/** Fraction of differing pixels above which a page counts as changed (0.02%). */
export const CHANGED_PAGE_THRESHOLD = 0.0002;
/** Pixel gap bridged when clustering differing pixels into boxes. */
export const CLUSTER_GAP = 8;

export interface PixelDiff {
  /** One byte per pixel: 1 = differs beyond the tolerance. */
  mask: Uint8Array;
  /** Number of set mask pixels. */
  count: number;
}

/**
 * Compare two same-size RGBA grids. A Uint32Array view gives the fast
 * equal-pixel path; only unequal pixels pay for the per-channel tolerance
 * check (small deltas are antialiasing noise, not content).
 */
export function diffPixels(a: PixelGrid, b: PixelGrid, tolerance = CHANNEL_TOLERANCE): PixelDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("diffPixels needs same-size grids");
  }
  const n = a.width * a.height;
  const ua = new Uint32Array(a.data.buffer, a.data.byteOffset, n);
  const ub = new Uint32Array(b.data.buffer, b.data.byteOffset, n);
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (ua[i] === ub[i]) continue;
    const p = i * 4;
    if (
      Math.abs(a.data[p] - b.data[p]) > tolerance ||
      Math.abs(a.data[p + 1] - b.data[p + 1]) > tolerance ||
      Math.abs(a.data[p + 2] - b.data[p + 2]) > tolerance ||
      Math.abs(a.data[p + 3] - b.data[p + 3]) > tolerance
    ) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}

/** Does this many differing pixels make the page "changed"? */
export function pageChanged(
  diffCount: number,
  width: number,
  height: number,
  threshold = CHANGED_PAGE_THRESHOLD,
): boolean {
  return diffCount > width * height * threshold;
}

/**
 * Cluster set mask pixels into bounding boxes: per-row runs (bridging gaps up
 * to `gap` px), runs merged into boxes when they touch vertically, then a
 * box-merge pass to a fixpoint so overlapping/adjacent boxes collapse.
 */
export function clusterBoxes(
  mask: Uint8Array,
  width: number,
  height: number,
  gap = CLUSTER_GAP,
): DiffBox[] {
  const boxes: DiffBox[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      if (!mask[row + x]) {
        x++;
        continue;
      }
      // A run: consecutive set pixels, tolerating gaps of up to `gap`.
      let lastSet = x;
      let probe = x + 1;
      while (probe < width && probe - lastSet <= gap) {
        if (mask[row + probe]) lastSet = probe;
        probe++;
      }
      mergeRun(boxes, { y, x0: x, x1: lastSet }, gap);
      x = lastSet + 1;
    }
  }
  // Box merge to a fixpoint: greedy run-joining can leave overlapping boxes
  // (e.g. an L-shape grown from two directions).
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxesNear(boxes[i], boxes[j], gap)) {
          boxes[i] = boxUnion(boxes[i], boxes[j]);
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes;
}

interface Run {
  y: number;
  x0: number;
  /** Inclusive. */
  x1: number;
}

/** Grow an existing nearby box to cover the run, or open a new one. */
function mergeRun(boxes: DiffBox[], run: Run, gap: number): void {
  const asBox: DiffBox = { x: run.x0, y: run.y, w: run.x1 - run.x0 + 1, h: 1 };
  for (let i = 0; i < boxes.length; i++) {
    if (boxesNear(boxes[i], asBox, gap)) {
      boxes[i] = boxUnion(boxes[i], asBox);
      return;
    }
  }
  boxes.push(asBox);
}

/** True when the boxes overlap or sit within `gap` px of each other. */
function boxesNear(a: DiffBox, b: DiffBox, gap: number): boolean {
  return (
    a.x <= b.x + b.w + gap &&
    b.x <= a.x + a.w + gap &&
    a.y <= b.y + b.h + gap &&
    b.y <= a.y + a.h + gap
  );
}

function boxUnion(a: DiffBox, b: DiffBox): DiffBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export interface PageComparison {
  changed: boolean;
  /** Fraction of differing pixels (0..1). */
  diffRatio: number;
  /** Changed regions; empty when the page is unchanged. */
  boxes: DiffBox[];
}

/**
 * Full per-page comparison: pixel diff → changed classification → boxes.
 * Grids of different dimensions (the page itself was resized) count as one
 * whole-page change.
 */
export function comparePage(
  a: PixelGrid,
  b: PixelGrid,
  opts: { tolerance?: number; threshold?: number; gap?: number } = {},
): PageComparison {
  if (a.width !== b.width || a.height !== b.height) {
    const w = Math.max(a.width, b.width);
    const h = Math.max(a.height, b.height);
    return { changed: true, diffRatio: 1, boxes: [{ x: 0, y: 0, w, h }] };
  }
  const { mask, count } = diffPixels(a, b, opts.tolerance);
  if (!pageChanged(count, a.width, a.height, opts.threshold)) {
    return { changed: false, diffRatio: count / (a.width * a.height), boxes: [] };
  }
  return {
    changed: true,
    diffRatio: count / (a.width * a.height),
    boxes: clusterBoxes(mask, a.width, a.height, opts.gap),
  };
}

/** One page's verdict in a whole-document comparison. */
export type PageStatus = "same" | "changed" | "added" | "removed";

export interface PageDiff {
  /** 1-indexed page number (in whichever document has the page). */
  page: number;
  status: PageStatus;
  /** Fraction of differing pixels; 1 for added/removed pages. */
  ratio: number;
  boxes: DiffBox[];
  /** Rendered page size at compare scale (current side when both exist). */
  width: number;
  height: number;
}
