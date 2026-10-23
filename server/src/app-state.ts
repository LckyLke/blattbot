// Per-boot, in-memory state shared by route modules and the turn runner.
// Nothing here is persisted: a restart starts with empty caches (the last
// compile is reloaded from disk by compile-service.ts, which fills lastCompile).
import { randomUUID } from "node:crypto";
import type { CompileResult } from "./compile.js";

export const lastCompile = new Map<string, CompileResult>();
const compileVersions = new WeakMap<CompileResult, string>();
/** Latest "Verify on Overleaf" build per project: the saved remote PDF's path. */
export const lastRemoteCompile = new Map<string, string>();

export function compilePublic(r: CompileResult & { version?: string; fingerprint?: string; at?: string }) {
  if (!compileVersions.has(r)) compileVersions.set(r, r.version ?? randomUUID());
  const { pdfPath, version: _version, fingerprint: _fingerprint, at: _at, ...rest } = r;
  return { ...rest, hasPdf: Boolean(pdfPath), pdfVersion: compileVersions.get(r)! };
}
