/** Bounded agent views. The full reports remain available to the UI and approval checks. */
import { z } from "zod";
import { evidenceView } from "./evidence.js";
import { strictReport } from "./strict.js";

const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
  key: z.string().min(1).max(500).optional(),
  file: z.string().min(1).max(1000).optional(),
};
export const evidencePageSchema = z.object({ ...pagination,
  status: z.enum(["all", "unchecked", "stale", "supported", "partially_supported", "not_supported", "unclear"]).default("all"),
  include_details: z.boolean().default(false),
});
export const strictPageSchema = z.object({ ...pagination,
  status: z.enum(["all", "open", "accepted"]).default("all"),
});
const clip = (text: string, max = 2000) => text.length > max ? text.slice(0, max) + "… [truncated]" : text;

export function boundedPage<T>(rows: T[], offset: number, limit: number) {
  const items: T[] = [];
  let size = 0;
  for (const row of rows.slice(offset, offset + limit)) {
    const chars = JSON.stringify(row, null, 2).length;
    if (items.length && size + chars > 24000) break;
    items.push(row); size += chars;
  }
  return { total: rows.length, offset, returned: items.length,
    nextOffset: offset + items.length < rows.length ? offset + items.length : null, items };
}
export function evidencePage(id: string, dir: string, input: unknown = {}) {
  const args = evidencePageSchema.parse(input);
  const all = evidenceView(id, dir);
  const counts: Record<string, number> = {};
  for (const row of all) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const rows = all.filter(row => (args.status === "all" || row.status === args.status) &&
    (!args.key || row.key === args.key) && (!args.file || row.file === args.file)).map(row => ({
      id: row.id, key: row.key, file: row.file, line: row.line, status: row.status,
      claim: clip(row.claim), claimTruncated: row.claim.length > 2000,
      basis: row.record?.source.basis ?? "not_checked",
      ...(args.include_details && row.record ? { record: {
        verdict: row.record.verdict, explanation: clip(row.record.explanation, 3000),
        limited: row.record.limited, checkedAt: row.record.checkedAt,
        quotes: row.record.quotes.slice(0, 5).map(quote => ({ page: quote.page, quote: clip(quote.quote, 1000) })),
        totalQuotes: row.record.quotes.length,
        source: { key: row.record.source.key, title: clip(row.record.source.title, 500), basis: row.record.source.basis, at: row.record.source.at },
      } } : {}),
    }));
  return { summary: { totalClaims: all.length, byStatus: counts }, ...boundedPage(rows, args.offset, args.limit),
    note: "Use nextOffset with the same filters for the next page. include_details adds bounded evidence excerpts. Claims may be shortened; verify_evidence uses the full claim ID. If the manuscript changes, restart at offset 0." };
}
export function strictReportPage(id: string, dir: string, input: unknown = {}) {
  const args = strictPageSchema.parse(input);
  const report = strictReport(id, dir);
  const rows = report.issues.filter(row =>
    (args.status === "all" || (args.status === "accepted" ? !!row.decision : !row.decision)) &&
    (!args.key || row.key === args.key) && (!args.file || row.file === args.file)).map(row => ({
      id: row.id, fingerprint: row.fingerprint, key: row.key, file: row.file, line: row.line,
      text: clip(row.text), textTruncated: row.text.length > 2000, reason: clip(row.reason),
      status: row.decision ? "accepted" : "open",
      ...(row.decision ? { decision: { ...row.decision, reason: clip(row.decision.reason) } } : {}),
    }));
  const { issues: _issues, ...summary } = report;
  const { items, ...page } = boundedPage(rows, args.offset, args.limit);
  return { ...summary, policy: { strict: report.strict }, ...page, issues: items,
    paginationNote: "Global ready/open and policy cover the entire manuscript, regardless of filters. Use nextOffset with the same filters. If the manuscript changes, restart at offset 0. Shortened passages can be located by file and line." };
}
