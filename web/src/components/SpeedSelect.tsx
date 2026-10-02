import { useState } from "react";
import type { Settings } from "../api";

type SpeedSettings = Pick<Settings, "backend" | "codexServiceTier">;

/** Shares the persisted speed choice with Settings → Agent. */
export default function SpeedSelect({ settings, onChange }: {
  settings: SpeedSettings;
  onChange: (patch: Pick<Settings, "codexServiceTier">) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  if (settings.backend && settings.backend !== "codex") return null;
  const current = settings.codexServiceTier || "";
  const label = current === "priority" ? "Fast" : current === "default" ? "Standard" : "Default speed";
  return (
    <label className={`relative flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[11px] transition-colors hover:bg-white/5 focus-within:ring-1 focus-within:ring-leaf ${current === "priority" ? "text-leaf" : "text-graphite hover:text-paper-dim"}`}
      title="Codex speed — applies from the next turn. Fast mode uses more of your Codex allowance on supported models.">
      <span aria-hidden="true">{label}</span>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4" /></svg>
      <select aria-label="Codex speed" value={current} disabled={saving}
        className="absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-default"
        onChange={async e => {
          const codexServiceTier = e.target.value as Settings["codexServiceTier"];
          setSaving(true);
          try { await onChange({ codexServiceTier }); }
          finally { setSaving(false); }
        }}>
        <option value="">Codex default</option>
        <option value="default">Standard</option>
        <option value="priority">Fast</option>
      </select>
    </label>
  );
}
