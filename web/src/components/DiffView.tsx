import type { DiffFile, DiffHunk } from "../diff";

/**
 * The hunk line table shared by the Proof panel and the chat's per-edit
 * expander: old/new line numbers, +/− gutter, and the line text.
 */
export function HunkLines({ hunk }: { hunk: DiffHunk }) {
  return (
    <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.55]">
      <tbody>
        {hunk.lines.map((line, li) => (
          <tr
            key={li}
            className={
              line.kind === "add"
                ? "bg-leaf/10 text-paper"
                : line.kind === "del"
                  ? "bg-pencil/10 text-paper-dim"
                  : "text-paper-dim"
            }
          >
            <td className="w-9 select-none border-r border-rule/60 pr-1.5 text-right align-top text-[10px] text-graphite/70">
              {line.oldNo ?? ""}
            </td>
            <td className="w-9 select-none border-r border-rule pr-1.5 text-right align-top text-[10px] text-graphite/70">
              {line.newNo ?? ""}
            </td>
            <td
              className={`w-4 select-none text-center align-top ${
                line.kind === "add"
                  ? "text-leaf"
                  : line.kind === "del"
                    ? "text-pencil"
                    : "text-transparent"
              }`}
            >
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : "·"}
            </td>
            <td className="whitespace-pre-wrap break-all pl-1 pr-3 align-top">{line.text || " "}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Compact read-only rendering of one file's hunks (used by the chat expander). */
export default function DiffView({ file }: { file: DiffFile }) {
  return (
    <>
      {file.hunks.map((hunk, hi) => (
        <div key={hi} className="mt-1 overflow-x-auto rounded border border-rule bg-ink-2/60 first:mt-0">
          {hunk.header && (
            <div className="border-b border-rule px-3 py-0.5 font-mono text-[10.5px] italic text-graphite">
              {hunk.header}
            </div>
          )}
          <HunkLines hunk={hunk} />
        </div>
      ))}
    </>
  );
}
