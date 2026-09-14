import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { DATA_DIR } from "../config.js";

const operations = new AsyncLocalStorage<{ signal: AbortSignal }>();
export const researchSignal = () => operations.getStore()?.signal;
export const assertResearchActive = () => researchSignal()?.throwIfAborted();
export const researchTimeout = (ms: number) => {
  const signal = researchSignal();
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
};
export const withResearchOperation = <T>(
  signal: AbortSignal,
  run: () => Promise<T>,
) => operations.run({ signal }, run);

export const digest = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const now = () => new Date().toISOString();
export function researchPath(projectId: string, name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId) || !/^[a-z-]+$/.test(name))
    throw new Error("invalid research store identifier");
  return join(DATA_DIR, "research", projectId, `${name}.json`);
}
export function readStore<T>(projectId: string, name: string, fallback: T): T {
  const path = researchPath(projectId, name);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function saveStore<T>(projectId: string, name: string, value: T): T {
  assertResearchActive();
  const path = researchPath(projectId, name);
  mkdirSync(join(DATA_DIR, "research", projectId), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
  return value;
}
/** Mutations are synchronous after any awaited work; concurrent jobs cannot lose unrelated records. */
export function updateStore<T>(
  id: string,
  name: string,
  fallback: T,
  update: (current: T) => T,
): T {
  return saveStore(id, name, update(readStore(id, name, fallback)));
}
export type ModelCall = (prompt: string) => Promise<string>;
export const modelCall: ModelCall = async (prompt) =>
  (await import("../agent.js")).runOneShot(prompt, researchSignal());
export function parseJson(raw: string): unknown {
  return JSON.parse(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, ""),
  );
}
