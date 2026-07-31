import { useEffect, useState } from "react";
import { api, type Project, type ProjectSettings as ProjectSettingsData } from "../api";

interface Props {
  project: Project;
  onClose: () => void;
  /** Called with the fresh settings after every successful save. */
  onSaved: (settings: ProjectSettingsData) => void;
}

const MODEL_SUGGESTIONS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "sonnet",
  "opus",
  "fable",
  "haiku",
];

/** Mirrors AGENT_MODES on the server (which validates the id). */
const MODE_OPTIONS = [
  ["", "Edit — the default"],
  ["research", "Research"],
  ["polish", "Polish"],
  ["review", "Review"],
  ["understand", "Understand"],
] as const;

const MAX_STYLE = 4000;

/**
 * Per-project settings modal: writing style/instructions, a model override,
 * and the default mode for new chats. Everything is optional — empty fields
 * fall back to the global settings.
 */
export default function ProjectSettings({ project, onClose, onSaved }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [style, setStyle] = useState("");
  const [model, setModel] = useState("");
  const [defaultMode, setDefaultMode] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .projectSettings(project.id)
      .then((s) => {
        setStyle(s.styleAppend ?? "");
        setModel(s.model ?? "");
        setDefaultMode(s.defaultMode ?? "");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoaded(true));
  }, [project.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const next = await api.saveProjectSettings(project.id, {
        styleAppend: style,
        model: model.trim(),
        defaultMode,
      });
      onSaved(next);
      setSavedMsg("Saved.");
      setTimeout(() => setSavedMsg(null), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Project settings"
        className="flex max-h-[88vh] w-[520px] max-w-full flex-col rounded-lg border border-rule bg-ink-2 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
      >
        <header className="booktabs flex items-baseline gap-3 px-5 pb-3 pt-4">
          <h2 className="font-serif text-[17px] font-semibold text-paper">Project settings</h2>
          <span className="min-w-0 truncate font-serif text-[13px] italic text-graphite">
            {project.name}
          </span>
          <button
            onClick={onClose}
            aria-label="Close project settings"
            className="ml-auto rounded px-1.5 text-lg leading-none text-graphite transition-colors hover:text-paper"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 text-[12px] leading-snug text-pencil">{error}</p>}
          {!loaded ? (
            <p className="text-sm text-graphite">Loading…</p>
          ) : (
            <>
              <p className="mb-4 font-serif text-[13px] leading-relaxed text-graphite">
                These apply to this project only, on top of the global agent settings.
              </p>

              <label className="block text-[11px] text-graphite">
                Writing style &amp; instructions{" "}
                <span className="text-graphite/60">(added to the agent's system prompt)</span>
                <textarea
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  rows={5}
                  maxLength={MAX_STYLE}
                  placeholder={
                    "e.g. Use British English. Prefer \\autoref. Keep sentences under 25 words."
                  }
                  className="mt-1 w-full resize-y rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs leading-relaxed text-paper placeholder:text-graphite/60"
                />
              </label>

              <label className="mt-3 block text-[11px] text-graphite">
                Model override{" "}
                <span className="text-graphite/60">
                  (empty = the global default; aliases sonnet/opus/fable/haiku work)
                </span>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list="blattbot-project-models"
                  placeholder="global default"
                  className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                />
                <datalist id="blattbot-project-models">
                  {MODEL_SUGGESTIONS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>

              <label className="mt-3 block text-[11px] text-graphite">
                Default mode for new chats
                <select
                  value={defaultMode}
                  onChange={(e) => setDefaultMode(e.target.value)}
                  className="mt-1 block rounded border border-rule bg-ink px-2.5 py-2 text-xs text-paper"
                >
                  {MODE_OPTIONS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-4 flex items-center gap-3">
                {savedMsg && <span className="text-[12px] text-leaf">{savedMsg}</span>}
                <button
                  onClick={save}
                  disabled={saving}
                  aria-label="Save project settings"
                  className="ml-auto rounded bg-leaf-deep px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
