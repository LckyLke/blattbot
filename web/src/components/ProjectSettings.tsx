import { useModelList } from "../models";
import { useEffect, useState } from "react";
import { api, type Project, type ProjectSettings as ProjectSettingsData } from "../api";
import SharedInstructionsSettings from "./SharedInstructionsSettings";

const COMPILER_LABELS: Record<string, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX", latex: "LaTeX" };

interface Props {
  project: Project;
  onClose: () => void;
  /** Called with the fresh settings after every successful save. */
  onSaved: (settings: ProjectSettingsData) => void;
  /** The main file changed — App reloads the project and recompiles a visible PDF. */
  onMainFileChanged?: () => void;
}

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
 * the main file to compile,
 * and the default mode for new chats. Everything is optional — empty fields
 * fall back to the global settings.
 */
export default function ProjectSettings({ project, onClose, onSaved, onMainFileChanged }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [style, setStyle] = useState("");
  const [model, setModel] = useState("");
  const [defaultMode, setDefaultMode] = useState("");
  const [trackChanges, setTrackChanges] = useState(false);
  const [labelPushes, setLabelPushes] = useState(false);
  /** The instructions as last saved (blattbot.md is created from these). */
  const [savedStyle, setSavedStyle] = useState("");
  const [saving, setSaving] = useState(false);
  const modelList = useModelList();
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Main-file choices (null until loaded or when the server could not list them). */
  const [mainChoices, setMainChoices] = useState<string[] | null>(null);
  const [mainFile, setMainFile] = useState("");
  const [savedMain, setSavedMain] = useState("");

  useEffect(() => {
    api
      .projectSettings(project.id)
      .then((s) => {
        setStyle(s.styleAppend ?? "");
        setSavedStyle(s.styleAppend ?? "");
        setTrackChanges(s.trackChanges === true);
        setLabelPushes(s.labelPushes === true);
        setModel(s.model ?? "");
        setDefaultMode(s.defaultMode ?? "");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoaded(true));
    api
      .mainFiles(project.id)
      .then((m) => {
        setMainChoices(m.candidates);
        setMainFile(m.mainTex ?? "");
        setSavedMain(m.mainTex ?? "");
      })
      .catch((err) => setError(`Couldn't list the main-file choices: ${err.message}`));
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
        ...(project.kind === "overleaf" ? { trackChanges, labelPushes } : {}),
      });
      setSavedStyle(next.styleAppend ?? "");
      onSaved(next);
      if (mainFile && mainFile !== savedMain) {
        await api.setMainFile(project.id, mainFile);
        setSavedMain(mainFile);
        onMainFileChanged?.();
      }
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
        className="flex max-h-[88vh] w-[520px] max-w-full flex-col rounded-2xl border border-rule bg-ink-2 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
      >
        <header className="flex items-baseline gap-3 px-5 pb-3 pt-4">
          <h2 className="font-sans text-[17px] font-semibold text-paper">Project settings</h2>
          <span className="min-w-0 truncate font-sans text-[13px] italic text-graphite">
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
              <p className="mb-4 font-sans text-[13px] leading-relaxed text-graphite">
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
                  className="mt-1 w-full resize-y rounded-lg border border-rule bg-ink px-2.5 py-2 font-mono text-xs leading-relaxed text-paper placeholder:text-graphite/60"
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
                  className="mt-1 w-full rounded-lg border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                />
                <datalist id="blattbot-project-models">
                  {modelList.models.map((m) => (
                    <option key={m.id} value={m.id} label={m.label !== m.id ? m.label : undefined} />
                  ))}
                </datalist>
              </label>

              {mainChoices && mainChoices.length > 0 && (
                <label className="mt-3 block text-[11px] text-graphite">
                  Main file{" "}
                  <span className="text-graphite/60">
                    (the document BlattBot compiles; Overleaf's own setting is unchanged)
                  </span>
                  <select
                    value={mainFile}
                    onChange={(e) => setMainFile(e.target.value)}
                    aria-label="Main file"
                    className="mt-1 block max-w-full rounded-lg border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper"
                  >
                    {!mainFile && <option value="">detect automatically</option>}
                    {mainChoices.map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {mainChoices && mainChoices.length === 0 && (
                <p className="mt-3 text-[11px] text-graphite">
                  Main file: no .tex file with a \documentclass line yet.
                </p>
              )}

              <label className="mt-3 block text-[11px] text-graphite">
                Default mode for new chats
                <select
                  value={defaultMode}
                  onChange={(e) => setDefaultMode(e.target.value)}
                  className="mt-1 block rounded-lg border border-rule bg-ink px-2.5 py-2 text-xs text-paper"
                >
                  {MODE_OPTIONS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              {project.kind === "overleaf" && (
                <div className="mt-3">
                  <label className="flex items-start gap-2 text-[12px] text-paper-dim">
                    <input
                      type="checkbox"
                      checked={trackChanges}
                      onChange={(e) => setTrackChanges(e.target.checked)}
                      className="mt-0.5 accent-[var(--color-leaf)]"
                    />
                    <span>
                      Push changes to Overleaf as tracked changes{" "}
                      <span className="rounded border border-gold/40 px-1 text-[10px] uppercase tracking-wide text-gold">experimental</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-graphite">
                        Co-authors can then accept or reject each approved edit in Overleaf's review panel. Needs Overleaf's
                        review features (overleaf.com or Server Pro; Community Edition has none) and review permission on the
                        project; new files, uploads and deletions cannot be tracked. BlattBot checks after each push and warns
                        when the changes were not recorded or cannot be reviewed.
                      </span>
                    </span>
                  </label>
                  <label className="mt-2 flex items-start gap-2 text-[12px] text-paper-dim">
                    <input
                      type="checkbox"
                      checked={labelPushes}
                      onChange={(e) => setLabelPushes(e.target.checked)}
                      className="mt-0.5 accent-[var(--color-leaf)]"
                    />
                    <span>
                      Label each push in Overleaf's history
                      <span className="mt-0.5 block text-[11px] leading-snug text-graphite">
                        Adds a label with the commit message (for example "Agent: tighten the intro (BlattBot)") to
                        Overleaf's History view after each approval, so co-authors see what BlattBot pushed and can
                        restore the version before it. If the label cannot be added, the push still counts and you get a
                        warning.
                      </span>
                    </span>
                  </label>
                  {project.overleafCompiler && (
                    <p className="mt-2 text-[11px] text-graphite">
                      Overleaf compiler: {COMPILER_LABELS[project.overleafCompiler] ?? project.overleafCompiler}
                      {project.mainTex ? ` · main document: ${project.mainTex}` : ""}
                    </p>
                  )}
                </div>
              )}

              <div className="mt-4 flex items-center gap-3">
                {savedMsg && <span className="text-[12px] text-leaf">{savedMsg}</span>}
                <button
                  onClick={save}
                  disabled={saving}
                  aria-label="Save project settings"
                  className="ml-auto rounded-lg bg-leaf-deep px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>

              <SharedInstructionsSettings projectId={project.id} savedStyle={savedStyle} styleDirty={style !== savedStyle} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
