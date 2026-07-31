/**
 * The chat composer's client-side attachment rules (W10). These mirror the
 * caps chatimages.ts enforces server-side — the point of having them in the
 * browser is a clear message before an upload, not security.
 *
 * Lives in a .tsx file for the same reason markdown.test.tsx does: it imports
 * a real web component module, which the server's tsc project does not build.
 */
import { describe, expect, it } from "vitest";
import {
  DOWNSCALE_ATTEMPTS,
  acceptImageFiles,
  downscaleImageFile,
  downscaleSize,
  tooLargeMessage,
} from "../../web/src/components/Chat.js";
import { MAX_CHAT_IMAGE_BYTES } from "../../web/src/api.js";
import { MAX_IMAGE_BYTES } from "../src/chatimages.js";

const file = (name: string, type: string, size = 32) =>
  new File([new Uint8Array(size)], name, { type });

describe("composer attachment rules", () => {
  it("accepts the four supported types", () => {
    const incoming = [
      file("a.png", "image/png"),
      file("b.jpg", "image/jpeg"),
      file("c.webp", "image/webp"),
      file("d.gif", "image/gif"),
    ];
    const { files, oversized, error } = acceptImageFiles(incoming, 0);
    expect(files.map((f) => f.name)).toEqual(["a.png", "b.jpg", "c.webp", "d.gif"]);
    expect(oversized).toEqual([]);
    expect(error).toBe("");
  });

  it("refuses anything that is not one of them, and says which file", () => {
    const { files, error } = acceptImageFiles([file("notes.pdf", "application/pdf")], 0);
    expect(files).toEqual([]);
    expect(error).toContain("notes.pdf");
    expect(error).toMatch(/PNG, JPEG, WebP, or GIF/);
  });

  it("refuses an SVG — scriptable, and not in the accepted set", () => {
    const { files, error } = acceptImageFiles([file("x.svg", "image/svg+xml")], 0);
    expect(files).toEqual([]);
    expect(error).toContain("x.svg");
  });

  it("routes an oversized image to the downscaler instead of refusing it", () => {
    const big = file("phone-photo.jpg", "image/jpeg", MAX_CHAT_IMAGE_BYTES + 1);
    const { files, oversized, error } = acceptImageFiles([big], 0);
    // Not accepted as-is, but not rejected either — the caller shrinks it.
    expect(files).toEqual([]);
    expect(oversized.map((f) => f.name)).toEqual(["phone-photo.jpg"]);
    expect(error).toBe("");
    // Only when shrinking fails does the user see the limit, stated in full.
    expect(tooLargeMessage(big)).toContain("phone-photo.jpg");
    expect(tooLargeMessage(big)).toContain("3.5 MB");
  });

  it("mirrors the server's cap exactly — one number, two enforcement points", () => {
    expect(MAX_CHAT_IMAGE_BYTES).toBe(MAX_IMAGE_BYTES);
    // Base64 inflates the payload to ~4/3; the Anthropic API refuses an image
    // block over 5 MiB encoded. Four of them must fit in one message too.
    const encoded = Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4;
    expect(encoded).toBeLessThan(5 * 1024 * 1024);
    expect(encoded * 4).toBeLessThan(32 * 1024 * 1024);
  });

  it("stops at four per message, counting what is already pending", () => {
    const five = Array.from({ length: 5 }, (_, i) => file(`${i}.png`, "image/png"));
    expect(acceptImageFiles(five, 0).files).toHaveLength(4);
    expect(acceptImageFiles(five, 0).error).toMatch(/At most 4 images/);
    // Two already staged → only two more fit.
    const { files, error } = acceptImageFiles(five, 2);
    expect(files).toHaveLength(2);
    expect(error).toMatch(/At most 4 images/);
    expect(acceptImageFiles(five, 4).files).toEqual([]);
  });

  it("counts oversized files against the four-per-message budget", () => {
    const huge = () => file("h.png", "image/png", MAX_CHAT_IMAGE_BYTES + 1);
    const mixed = [huge(), huge(), file("a.png", "image/png"), file("b.png", "image/png"), huge()];
    const { files, oversized, error } = acceptImageFiles(mixed, 0);
    // Four slots total — shrinking two big ones must not yield six thumbnails.
    expect(files.length + oversized.length).toBe(4);
    expect(error).toMatch(/At most 4 images/);
  });

  it("keeps the good files when only some are refused", () => {
    const { files, error } = acceptImageFiles(
      [file("script.sh", "text/x-shellscript"), file("shot.png", "image/png")],
      0,
    );
    expect(files.map((f) => f.name)).toEqual(["shot.png"]);
    expect(error).toContain("script.sh");
  });
});

describe("browser-side downscaling", () => {
  const MB = 1024 * 1024;

  it("shrinks the longest edge by the square root of the overshoot", () => {
    // 4x over the cap → half the edge each way → a quarter of the pixels.
    expect(downscaleSize(4000, 3000, 4 * MB, 1 * MB)).toEqual({ width: 2000, height: 1500 });
    // 2x over → 1/sqrt(2) of each edge.
    expect(downscaleSize(4000, 3000, 2 * MB, 1 * MB)).toEqual({ width: 2828, height: 2121 });
  });

  it("preserves the aspect ratio", () => {
    const { width, height } = downscaleSize(4032, 3024, 8 * MB, 3.5 * MB);
    expect(width / height).toBeCloseTo(4032 / 3024, 2);
  });

  it("never upscales an image that already fits", () => {
    expect(downscaleSize(800, 600, 1 * MB, 3.5 * MB)).toEqual({ width: 800, height: 600 });
  });

  it("tightens by a further 15 % on each retry, because re-encoding is not exact", () => {
    const first = downscaleSize(4000, 3000, 4 * MB, 1 * MB);
    const second = downscaleSize(4000, 3000, 4 * MB, 1 * MB, 1);
    expect(second.width).toBe(Math.round(first.width * 0.85));
    expect(second.height).toBe(Math.round(first.height * 0.85));
    // Every retry is strictly smaller than the one before it, so the loop ends.
    let prev = Infinity;
    for (let a = 0; a < DOWNSCALE_ATTEMPTS; a++) {
      const w = downscaleSize(4000, 3000, 4 * MB, 1 * MB, a).width;
      expect(w).toBeLessThan(prev);
      prev = w;
    }
  });

  it("never returns a zero-pixel canvas", () => {
    expect(downscaleSize(10, 10, 500 * MB, 1)).toEqual({ width: 1, height: 1 });
    expect(downscaleSize(0, 0, 4 * MB, 1 * MB)).toEqual({ width: 0, height: 0 });
  });

  it("passes an image that already fits straight through", async () => {
    const small = file("ok.png", "image/png", 1024);
    expect(await downscaleImageFile(small)).toBe(small);
  });

  it("refuses to re-encode an oversized GIF — that would drop the animation", async () => {
    const anim = file("loop.gif", "image/gif", MAX_CHAT_IMAGE_BYTES + 1);
    expect(await downscaleImageFile(anim)).toBeNull();
  });

  it("returns null instead of throwing when there is no canvas to draw on", async () => {
    // vitest runs this file in node: no document, no createImageBitmap. The
    // composer must then fall back to the size error, never to an exception.
    const big = file("huge.png", "image/png", MAX_CHAT_IMAGE_BYTES + 1);
    expect(await downscaleImageFile(big)).toBeNull();
  });
});
