/**
 * The model pick-list, shared by the chat's model chip, Settings → Agent, and
 * the per-project settings. The server answers /api/models from the engine's
 * own catalog (display names, aliases with their resolution, effort support)
 * and falls back to a static list; this module caches that answer for the
 * page and offers the static list until it arrives.
 */
import { useEffect, useState } from "react";
import { api, type ModelList, type ModelOption, type BackendId, type Settings } from "./api";

/** What the UI shows before the server answers (and if it never does). */
export const STATIC_MODELS: ModelOption[] = [
  { id: "claude-sonnet-5", label: "claude-sonnet-5" },
  { id: "claude-opus-5", label: "claude-opus-5" },
  { id: "claude-fable-5-1", label: "claude-fable-5-1" },
  { id: "claude-fable-5", label: "claude-fable-5" },
  { id: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001" },
  { id: "sonnet", label: "sonnet → claude-sonnet-5", resolvesTo: "claude-sonnet-5" },
  { id: "opus", label: "opus → claude-opus-5", resolvesTo: "claude-opus-5" },
  { id: "fable", label: "fable → claude-fable-5-1", resolvesTo: "claude-fable-5-1" },
  { id: "haiku", label: "haiku → claude-haiku-4-5-20251001", resolvesTo: "claude-haiku-4-5-20251001" },
];

/** Short display label for a model id: "claude-sonnet-5" → "sonnet-5". */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}

const cached = new Map<string, ModelList>();
const inflight = new Map<string, Promise<ModelList>>();
let generation = 0;

export function modelSettingPatch(backend: Settings["backend"], model: string): Partial<Settings> {
  return backend === "claude" ? { model } : backend === "openai" ? { openaiModel: model } : { codexModel: model };
}

function fallback(backend?: BackendId): ModelList {
  return { backend, models: backend === "claude" ? STATIC_MODELS : [], source: "static" };
}

export function fetchModelList(refresh = false, backend?: BackendId): Promise<ModelList> {
  const key = backend ?? "active";
  if (cached.has(key) && !refresh) return Promise.resolve(cached.get(key)!);
  if (inflight.has(key) && !refresh) return inflight.get(key)!;
  const current = generation;
  const promise = api
    .models(refresh, backend)
    .then((list) => {
      if (current === generation) cached.set(key, list);
      return list;
    })
    .catch(() => cached.get(key) ?? fallback(backend))
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** The current list (static until the server answers) and its source. */
export function useModelList(backend?: BackendId): ModelList {
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<ModelList>(cached.get(backend ?? "active") ?? fallback(backend));
  useEffect(() => {
    const changed = () => {
      generation++;
      cached.clear();
      inflight.clear();
      setRevision((n) => n + 1);
    };
    window.addEventListener("blattbot:settings-changed", changed);
    return () => window.removeEventListener("blattbot:settings-changed", changed);
  }, []);
  useEffect(() => {
    let stale = false;
    setList(cached.get(backend ?? "active") ?? fallback(backend));
    void fetchModelList(false, backend).then((l) => {
      if (!stale) setList(l);
    });
    return () => {
      stale = true;
    };
  }, [backend, revision]);
  return list;
}

/** Concrete model ids only (no aliases) — for the chat chip's curated picks. */
export function concreteModels(list: ModelList): ModelOption[] {
  return list.models.filter((m) => !m.resolvesTo);
}
