import { EDITOR_SHEET, SHORTCUT_SHEET, type SheetRow } from "../shortcuts";

function Keys({ row }: { row: SheetRow }) {
  const join = row.join ?? "or";
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.keys.map((k, i) => (
        <span key={k} className="flex items-center gap-1">
          {i > 0 && <span className="text-[11px] text-graphite">{join}</span>}
          <kbd className="rounded border border-rule bg-ink px-1.5 py-px font-mono text-[11.5px] text-paper">{k}</kbd>
        </span>
      ))}
    </span>
  );
}

function Table({ title, rows }: { title: string; rows: SheetRow[] }) {
  return (
    <section className="mt-3 first:mt-0">
      <h3 className="mb-1 text-[11px] uppercase tracking-wide text-graphite">{title}</h3>
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-rule/50">
              <td className="whitespace-nowrap py-1 pr-3 align-top">
                <Keys row={r} />
              </td>
              <td className="py-1 text-paper-dim">{r.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The keyboard cheat sheet ("?" or the sidebar's Keyboard shortcuts entry). */
export default function ShortcutSheet() {
  return (
    <div>
      <p className="mb-2 text-[12px] text-graphite">
        Single keys work while the cursor is not in a text field or an editor.
      </p>
      <Table title="In a project" rows={SHORTCUT_SHEET} />
      <Table title="In the editors" rows={EDITOR_SHEET} />
    </div>
  );
}
