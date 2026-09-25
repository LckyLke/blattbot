import { useEffect, useId, useRef, useState } from "react";
import { api, type UsageLimits as Limits } from "../api";

export default function UsageLimits({ backend, busy }: { backend: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (backend !== "codex") return;
    let active = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const result = await api.codexLimits();
        if (active) { setLimits(result); setError(""); }
      } catch {
        if (active) { setLimits(null); setError("Usage limits could not be loaded."); }
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [backend, busy, refresh]);
  const windows = backend === "codex" ? limits?.windows ?? [] : [];
  const remaining = windows.length ? Math.min(...windows.map(w => w.remainingPercent)) : null;
  const tone = remaining !== null && remaining <= 10 ? "text-pencil" : remaining !== null && remaining <= 25 ? "text-gold" : "text-leaf/80";
  return (
    <div ref={root} className="shrink-0">
      <button ref={trigger} type="button" aria-label="Usage limits" aria-expanded={open} aria-controls={panelId}
        title={remaining === null ? "Usage limits" : `Usage limits · ${Math.round(remaining)}% remaining in the lowest quota window`}
        onClick={() => setOpen(value => !value)}
        className="usage-trigger flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" className={remaining === null ? "text-graphite" : tone}>
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" opacity=".18" />
          {remaining !== null && <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" pathLength="100" strokeDasharray={`${remaining} 100`} transform="rotate(-90 10 10)" />}
        </svg>
        <span className="usage-trigger-label tabular-nums">{remaining === null ? "Usage" : `${Math.round(remaining)}% left`}</span>
        <svg className="usage-trigger-chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && <div id={panelId} role="region" aria-label="Usage limits details"
        className="absolute bottom-full left-0 z-30 mb-2 w-80 max-w-full rounded-xl border border-rule bg-ink-2 p-4 text-[11px] text-paper-dim shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium text-paper">Usage limits</span>
          <span className="text-[10px] text-graphite">{backend === "codex" ? "Codex account" : "Account"}</span>
        </div>
        {backend !== "codex" ? <p className="text-graphite">This provider does not expose account limits to BlattBot.</p> : <>
          <div className="max-h-64 space-y-4 overflow-y-auto">
            {windows.map((w, i) => <div key={i}>
              <div className="mb-1.5 flex justify-between gap-2">
                <span>{w.window} window{w.bucket !== "codex" && <span className="text-graphite"> · {w.bucket}</span>}</span>
                <span className="tabular-nums">{Math.round(w.remainingPercent)}% remaining</span>
              </div>
              <div role="progressbar" aria-label={`${w.bucket} ${w.window} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.remainingPercent}
                className="h-1 overflow-hidden rounded-full bg-white/5">
                <div className={`h-full rounded-full transition-[width] ${w.remainingPercent <= 10 ? "bg-pencil/80" : w.remainingPercent <= 25 ? "bg-gold/80" : "bg-leaf/70"}`} style={{ width: `${w.remainingPercent}%` }} />
              </div>
              <div className="mt-1.5 text-[10px] text-graphite">{w.resetsAt ? `Resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : "Reset time unavailable"}</div>
            </div>)}
          </div>
          {(error || limits?.message) && <p role="status" className="text-graphite">{error || limits?.message}</p>}
          {loading && !limits && <p role="status" className="text-graphite">Loading usage limits…</p>}
          <div className="mt-4 border-t border-rule pt-3 text-[10px] text-graphite">
            <p>Shared across projects and apps.</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span>{limits && `Updated ${new Date(limits.checkedAt).toLocaleTimeString()}`}</span>
              <button type="button" disabled={loading} onClick={() => setRefresh(n => n + 1)}
                className="-mr-1 rounded px-1 py-1 transition-colors hover:text-paper disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
            </div>
          </div>
        </>}
      </div>}
    </div>
  );
}
