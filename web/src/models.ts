/**
 * The model pick-list, shared by the chat's model chip, Settings → Agent, and
 * the per-project settings. The server answers /api/models from the engine's
 * own catalog (display names, aliases with their resolution, effort support)
 * and falls back to a static list; this module caches that answer for the
 * page and offers the static list until it arrives.
 */
import { useEffect, useState } from "react";
import { api, type ModelList, type ModelOption } from "./api";

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

let cached: ModelList | null = null;
let inflight: Promise<ModelList> | null = null;

export function fetchModelList(refresh = false): Promise<ModelList> {
  if (cached && !refresh) return Promise.resolve(cached);
  if (inflight && !refresh) return inflight;
  inflight = api
    .models(refresh)
    .then((list) => {
      cached = list.models.length > 0 ? list : { models: STATIC_MODELS, source: "static" };
      return cached;
    })
    .catch(() => {
      cached = cached ?? { models: STATIC_MODELS, source: "static" };
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The current list (static until the server answers) and its source. */
export function useModelList(): ModelList {
  const [list, setList] = useState<ModelList>(cached ?? { models: STATIC_MODELS, source: "static" });
  useEffect(() => {
    let stale = false;
    void fetchModelList().then((l) => {
      if (!stale) setList(l);
    });
    return () => {
      stale = true;
    };
  }, []);
  return list;
}

/** Concrete model ids only (no aliases) — for the chat chip's curated picks. */
export function concreteModels(list: ModelList): ModelOption[] {
  return list.models.filter((m) => !m.resolvesTo);
}
