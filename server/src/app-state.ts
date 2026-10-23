// Per-boot, in-memory state shared by route modules and the turn runner.
// Nothing here is persisted: a restart starts with empty caches.
import { randomUUID } from "node:crypto";
import type { CompileResult } from "./compile.js";

export const lastCompile = new Map<string, CompileResult>();
const compileVersions = new WeakMap<CompileResult, string>();
/** Latest "Verify on Overleaf" build per project: the saved remote PDF's path. */
export const lastRemoteCompile = new Map<string, string>();

export function compilePublic(r: CompileResult) {
  if (!compileVersions.has(r)) compileVersions.set(r, randomUUID());
  const { pdfPath, ...rest } = r;
  return { ...rest, hasPdf: Boolean(pdfPath), pdfVersion: compileVersions.get(r)! };
}
