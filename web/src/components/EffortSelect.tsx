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
    <label className="flex shrink-0 items-center gap-1 rounded-full border border-rule px-2.5 py-0.5 text-[11px] text-graphite"
      title={unsupported ? "This model does not support reasoning effort" : "Global reasoning effort — applies from the next turn"}>
      <span>Effort</span>
      <select aria-label="Reasoning effort" value={current} disabled={saving || (unsupported && !current)}
        className="min-w-0 rounded bg-ink font-mono text-[11px] text-paper-dim outline-none focus-visible:ring-1 focus-visible:ring-leaf disabled:opacity-50"
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
