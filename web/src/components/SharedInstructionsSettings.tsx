import { useCallback, useEffect, useState } from "react";
import { reviewApi, type SharedInstructionsState } from "../overleaf-review";

interface Props {
  projectId: string;
  /** The saved local project instructions (what "Create blattbot.md" writes). */
  savedStyle: string;
  /** The instructions field has unsaved edits. */
  styleDirty: boolean;
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Project settings section for blattbot.md, the instructions shared with
 * co-authors through the project itself. Shows the file, which version the
 * agent uses, and a confirm button when the file is new or changed (it is
 * pinned by hash, so a co-author's edit never reaches the agent unreviewed).
 */
export default function SharedInstructionsSettings({ projectId, savedStyle, styleDirty }: Props) {
  const [state, setState] = useState<SharedInstructionsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    reviewApi
      .sharedInstructions(projectId)
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((err) => setError(String(err?.message ?? err)));
  }, [projectId]);
  useEffect(load, [load]);

  async function act(action: () => Promise<SharedInstructionsState>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setState(await action());
      if (done) setNote(done);
    } catch (err: any) {
      setError(String(err?.message ?? err));
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Shared instructions" className="mt-5 border-t border-rule pt-4">
      <h3 className="font-sans text-[13px] font-semibold text-paper">
        Shared instructions <span className="font-mono text-[11.5px] font-normal text-graphite">blattbot.md</span>
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-graphite">
        A <code className="font-mono">blattbot.md</code> file at the project root holds agent instructions for every co-author who
        uses BlattBot; it syncs through Overleaf like any file. Co-authors can change it, so the agent only uses a version you
        confirmed. Your own project instructions above still apply after it.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[12px] leading-snug text-pencil">
          {error}
        </p>
      )}
      {note && <p className="mt-2 text-[12px] leading-snug text-leaf">{note}</p>}
      {!state && !error && <p className="mt-2 text-[12px] text-graphite">Loading…</p>}

      {state && !state.exists && (
        <div className="mt-2">
          <button
            onClick={() =>
              void act(
                async () => (await reviewApi.createSharedInstructions(projectId)).state,
                "Created blattbot.md as a pending change — approve it in Proof to share it on Overleaf. If it repeats your project instructions above, clear those.",
              )
            }
            disabled={busy || !savedStyle.trim() || styleDirty}
            title={styleDirty ? "Save your project instructions first" : !savedStyle.trim() ? "Write and save project instructions first" : undefined}
            className="rounded-lg border border-rule px-3 py-1.5 text-[12px] text-paper-dim transition-colors hover:border-leaf/50 hover:text-paper disabled:opacity-50"
          >
            Create blattbot.md from my project instructions
          </button>
          {(styleDirty || !savedStyle.trim()) && (
            <p className="mt-1 text-[11px] text-graphite">
              {styleDirty ? "Save your project instructions first." : "Write and save project instructions above first."}
            </p>
          )}
        </div>
      )}

      {state?.exists && (
        <div className="mt-2">
          {state.error ? (
            <p className="text-[12px] text-pencil">{state.error}</p>
          ) : (
            <>
              <p
                data-shared-status={state.status}
                className={`text-[12px] leading-snug ${state.needsReview ? "text-gold" : "text-leaf"}`}
              >
                {state.status === "confirmed" && `In use — confirmed ${when(state.confirmedAt)}.`}
                {state.status === "none" && "The file is empty — nothing to use."}
                {state.needsReview &&
                  (state.usingPrevious
                    ? `Changed since you confirmed it — the agent still uses the version you confirmed ${when(state.confirmedAt)}. Review the new text:`
                    : "Not used yet — review the text and confirm it:")}
              </p>
              <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-rule bg-ink px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-paper">
                {state.content}
              </pre>
              {state.truncated && (
                <p className="mt-1 text-[11px] text-graphite">Only the first 4000 characters are given to the agent.</p>
              )}
              {state.needsReview && state.sha256 && (
                <button
                  onClick={() => void act(() => reviewApi.confirmSharedInstructions(projectId, state.sha256!), "Confirmed — the agent uses these instructions from the next message on.")}
                  disabled={busy}
                  className="mt-2 rounded-lg bg-leaf-deep px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
                >
                  Use these instructions
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
