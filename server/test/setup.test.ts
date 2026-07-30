import { describe, expect, it } from "vitest";
import { TECTONIC_VERSION, tectonicAssetCandidates, tectonicAssetUrl } from "../src/setup.js";

const BASE = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}`;

describe("tectonicAssetUrl", () => {
  it("linux x64 prefers the gnu build", () => {
    expect(tectonicAssetUrl("linux", "x64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    );
  });

  it("linux x64 falls back to musl", () => {
    expect(tectonicAssetCandidates("linux", "x64")).toEqual([
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    ]);
  });

  it("linux arm64 only ships as musl", () => {
    expect(tectonicAssetCandidates("linux", "arm64")).toEqual([
      `${BASE}/tectonic-${TECTONIC_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    ]);
  });

  it("macOS covers both architectures", () => {
    expect(tectonicAssetUrl("darwin", "x64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-apple-darwin.tar.gz`,
    );
    expect(tectonicAssetUrl("darwin", "arm64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-aarch64-apple-darwin.tar.gz`,
    );
  });

  it("windows x64 is a zip (msvc build)", () => {
    expect(tectonicAssetUrl("win32", "x64")).toBe(
      `${BASE}/tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`,
    );
  });

  it("unsupported platforms return null / empty", () => {
    expect(tectonicAssetUrl("freebsd", "x64")).toBeNull();
    expect(tectonicAssetUrl("win32", "arm64")).toBeNull();
    expect(tectonicAssetCandidates("aix", "ppc64")).toEqual([]);
  });
});
