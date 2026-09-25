import { useState } from "react";
import type { Settings } from "../api";
import { useModelList } from "../models";

type EffortSettings = Pick<Settings, "backend" | "codexEffort" | "effort">;
const CODEX_LEVELS: Settings["codexEffort"][] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const CLAUDE_LEVELS: Settings["effort"][] = ["low", "medium", "high", "xhigh", "max"];

/** Uses the same persisted backend setting as Settings → Agent. */
export default function EffortSelect({ model, settings, onChange }: {
  model: string;
  settings: EffortSettings;
  onChange: (patch: Partial<EffortSettings>) => Promise<void>;
}) {
  const backend = settings.backend || "codex";
  const catalog = useModelList(backend);
  const [saving, setSaving] = useState(false);
  // The compatible-endpoint backend does not send a reasoning-effort parameter.
  if (backend === "openai") return null;
  const current = backend === "claude" ? settings.effort : settings.codexEffort;
  const option = catalog.models.find(m => m.id === (model || catalog.defaultModel));
  const allowed: readonly string[] = backend === "claude" ? CLAUDE_LEVELS : CODEX_LEVELS;
  const unsupported = option?.supportsEffort === false || (option?.effortLevels?.length === 0);
  const levels = unsupported ? [] : [...new Set(option?.effortLevels ??
    (backend === "claude" ? CLAUDE_LEVELS : ["low", "medium", "high", "xhigh"]))].filter(level => allowed.includes(level));
  const unavailable = Boolean(current && !levels.includes(current));
  return (
    <label className="relative flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[11px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim focus-within:ring-1 focus-within:ring-leaf"
      title={unsupported ? "This model does not support reasoning effort" : "Global reasoning effort — applies from the next turn"}>
      <span aria-hidden="true">{current ? current.charAt(0).toUpperCase() + current.slice(1) : "Default"} effort</span>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4" /></svg>
      <select aria-label="Reasoning effort" value={current} disabled={saving || (unsupported && !current)}
        className="absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-default"
        onChange={async e => {
          const effort = e.target.value;
          setSaving(true);
          try {
            await onChange(backend === "claude" ? { effort: effort as Settings["effort"] } : { codexEffort: effort as Settings["codexEffort"] });
          } finally { setSaving(false); }
        }}>
        <option value="">{backend === "codex" ? "Codex default" : "Model default"}</option>
        {unavailable && <option value={current} disabled>{current} (unavailable)</option>}
        {levels.map(level => <option key={level} value={level}>{level}</option>)}
      </select>
    </label>
  );
}
