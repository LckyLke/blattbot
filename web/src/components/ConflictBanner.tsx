import type { ConflictHunk, SyncConflict } from "../api";

interface Props {
  conflicts: SyncConflict[];
  /** "approve": a push was refused; "sync": a sync found the overlap first. */
  source: "approve" | "sync";
  /** Buttons lock while anything else runs. */
  locked: boolean;
  /** Overleaf projects can keep or overwrite a version; Git-bridge files are resolved by editing them. */
  overleaf: boolean;
  /** The file whose action is in flight. */
  acting: string | null;
  onKeepOverleaf: (paths: string[]) => void;
  onResolveInEditor: (conflict: SyncConflict) => void;
  onOverwrite: (path: string) => void;
  onOverwriteAll: () => void;
}

const BUTTON =
  "rounded-lg border border-rule px-2 py-0.5 text-[11.5px] text-paper-dim transition-colors hover:border-graphite hover:text-paper disabled:opacity-50";

/** What happened to the file, in a few words. */
function describe(c: SyncConflict): string {
  if (c.kind === "deleted-remote") return "deleted on Overleaf, edited here";
  if (c.kind === "deleted-local") return "changed on Overleaf, deleted here";
  if (c.kind === "unmerged") return "Git conflict markers in the file";
  if (c.binary) return "not a text file — changed on both sides";
  const n = (c.hunks?.length ?? 0) + (c.more ?? 0);
  return n > 0 ? `${n} overlapping change${n === 1 ? "" : "s"}` : "changed on both sides";
}

/**
 * Files Overleaf and the local tree both changed in overlapping places:
 * per file, what each side did (Overleaf | before | yours) and what to keep.
 */
export default function ConflictBanner(props: Props) {
  const { conflicts, source, locked, overleaf } = props;
  const n = conflicts.length;
  const files = `${n} file${n === 1 ? "" : "s"}`;
  return (
    <section
      aria-label="Overleaf conflicts"
      className="max-h-[45%] shrink-0 overflow-y-auto border-b border-gold/40 bg-gold/10 px-4 py-3"
    >
      <p role="status" className="text-[12.5px] font-medium text-gold">
        {!overleaf
          ? `A sync left Git conflicts in ${files} — resolve them before approving`
          : source === "approve"
            ? `Overleaf changed ${files} you also edited — nothing was pushed`
            : `Overleaf also changed ${files} you edited — the edits overlap`}
      </p>
      <p className="mt-0.5 text-[11.5px] text-paper-dim">
        {overleaf
          ? "Edits to different lines merge automatically; these overlap. Choose for each file what to keep."
          : "Edit each file to remove the <<<<<<< ======= >>>>>>> markers, keeping what belongs."}
      </p>
      <ul className="mt-2 space-y-2">
        {conflicts.map((c) => (
          <ConflictFile key={c.path} conflict={c} {...props} />
        ))}
      </ul>
      {overleaf && n > 1 && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-gold/20 pt-2">
          <button
            onClick={() => props.onKeepOverleaf(conflicts.map((c) => c.path))}
            disabled={locked}
            className={BUTTON}
          >
            Keep Overleaf's version of all {n} files
          </button>
          <button
            onClick={props.onOverwriteAll}
            disabled={locked}
            className="rounded-lg bg-pencil/90 px-2 py-0.5 text-[11.5px] font-medium text-ink transition-colors hover:bg-pencil disabled:opacity-50"
          >
            Overwrite Overleaf with all {n} files
          </button>
        </div>
      )}
    </section>
  );
}

function ConflictFile({
  conflict: c,
  locked,
  overleaf,
  acting,
  onKeepOverleaf,
  onResolveInEditor,
  onOverwrite,
}: Props & { conflict: SyncConflict }) {
  const text = c.kind === "modified" && !c.binary;
  return (
    <li aria-label={`Conflict in ${c.path}`} className="rounded-lg border border-gold/30 bg-ink/40">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
        <span className="font-mono text-[12px] text-paper">{c.path}</span>
        <span className="text-[11px] text-pencil">{describe(c)}</span>
        {acting === c.path && <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-gold" />}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {overleaf && (
            <button
              onClick={() => onKeepOverleaf([c.path])}
              disabled={locked}
              aria-label={`Keep Overleaf's version of ${c.path}`}
              title={`Drop your edits to ${c.path} and take Overleaf's version; other files keep their edits`}
              className={BUTTON}
            >
              Keep Overleaf's version
            </button>
          )}
          {(text || c.kind === "unmerged") && (
            <button
              onClick={() => onResolveInEditor(c)}
              disabled={locked}
              aria-label={`Resolve ${c.path} in the editor`}
              title={
                c.kind === "unmerged"
                  ? `Open ${c.path} where the conflict markers are`
                  : `Write both versions into ${c.path} with conflict markers, then edit it in Source`
              }
              className={BUTTON}
            >
              Resolve in editor
            </button>
          )}
          {overleaf && (
            <button
              onClick={() => onOverwrite(c.path)}
              disabled={locked}
              aria-label={`Overwrite ${c.path} on Overleaf`}
              title={`Push your version of ${c.path} over Overleaf's (Overleaf's is backed up locally first)`}
              className="rounded-lg border border-pencil/50 px-2 py-0.5 text-[11.5px] text-pencil transition-colors hover:bg-pencil/10 disabled:opacity-50"
            >
              Overwrite Overleaf
            </button>
          )}
        </span>
      </div>
      {c.hunks && c.hunks.length > 0 && (
        <div className="space-y-1.5 border-t border-gold/20 px-2.5 py-1.5">
          {c.hunks.map((h, i) => (
            <HunkSides key={i} hunk={h} />
          ))}
          {c.more ? <p className="text-[11px] text-graphite">…and {c.more} more overlapping change{c.more === 1 ? "" : "s"}</p> : null}
        </div>
      )}
    </li>
  );
}

function HunkSides({ hunk }: { hunk: ConflictHunk }) {
  return (
    <div className="@container">
      <p className="font-mono text-[10.5px] text-graphite">line {hunk.line}</p>
      <div className="mt-0.5 grid grid-cols-1 gap-1 @sm:grid-cols-3">
        <Side label="Overleaf" text={hunk.remote} cls="border-gold/40" />
        <Side label="Before" text={hunk.base} cls="border-rule" />
        <Side label="Yours" text={hunk.mine} cls="border-leaf/40" />
      </div>
    </div>
  );
}

function Side({ label, text, cls }: { label: string; text: string; cls: string }) {
  return (
    <div className={`min-w-0 rounded border ${cls} bg-ink-2/60`}>
      <p className="border-b border-rule/60 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-graphite">{label}</p>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words px-1.5 py-1 font-mono text-[11px] leading-snug text-paper-dim">
        {text === "" ? <span className="italic text-graphite">(nothing)</span> : text}
      </pre>
    </div>
  );
}
