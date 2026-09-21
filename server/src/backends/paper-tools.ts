/** Source gaps reach the chat directly, independent of the model's final answer. */
import { formatCitationCheckResult, formatPaperReadResult, readPaper, verifyCitationSupportBatch, type CitationCheckResult, type PaperReadOptions } from "../papers.js";
import type { BackendTurnContext } from "./types.js";
import { withResearchOperation } from "../research/store.js";

const notices = new WeakMap<BackendTurnContext, Set<string>>();
function warn(ctx: BackendTurnContext, text: string): void {
  let seen = notices.get(ctx);
  if (!seen) notices.set(ctx, seen = new Set());
  if (seen.has(text)) return;
  seen.add(text);
  ctx.emit({ type: "notice", tone: "warn", text });
}

export async function readPaperTool(ctx: BackendTurnContext, key: string, opts: PaperReadOptions = {}): Promise<string> {
  try {
    const result = await withResearchOperation(ctx.signal, () => readPaper(ctx.project.id, ctx.dir, key, { ...opts, contextDirs: ctx.contextDirs }));
    if (result.excerpt?.hasText) (ctx.paperReads ??= new Set()).add(key);
    if (result.basis !== "full_text") {
      const limitations = result.limitations.map(line => line.replace(/^Only the abstract is available\.\s*/, "")).join(" ");
      warn(ctx, `${result.title} (${key}): ${result.basis === "abstract" ? "Only the abstract is available." : result.basis === "summary" ? "Only a publisher summary is available." : "No readable source is available."} ${limitations}`);
    } else if (result.limitations.some((line) => line.startsWith("No extractable text on pages"))) {
      warn(ctx, `${result.title} (${key}): ${result.limitations.join(" ")}`);
    }
    return formatPaperReadResult(result);
  } catch (error: any) {
    warn(ctx, `Could not read paper ${key}: ${error?.message ?? error}. Its content has not been established by this read. Provide the correct bibliography key and a readable PDF or relevant passages.`);
    throw error;
  }
}

const citationReports = new WeakMap<BackendTurnContext, Map<string, Map<string, CitationCheckResult>>>();

export async function verifyPaperTool(ctx: BackendTurnContext, key: string, claim: string | string[]): Promise<string> {
  const claims = Array.isArray(claim) ? claim : [claim];
  try {
    const results = await verifyCitationSupportBatch(ctx.project.id, ctx.dir, key, claims, { contextDirs: ctx.contextDirs });
    let papers = citationReports.get(ctx);
    if (!papers) citationReports.set(ctx, papers = new Map());
    let checked = papers.get(key);
    if (!checked) papers.set(key, checked = new Map());
    claims.forEach((claim, index) => checked!.set(claim, results[index]));
    const entries = [...checked];
    const issues = entries.filter(([, result]) => result.verdict !== "supported");
    const limited = entries.some(([, result]) => result.basis !== "full_text" || result.truncated);
    ctx.emit({ type: "notice", citationGroup: key, tone: issues.length ? "warn" : limited ? "info" : "ok",
      text: `${key}: ${entries.length - issues.length}/${entries.length} claims supported${issues.length ? ` · ${issues.length} need attention` : ""}${limited ? " · some checks use excerpts or abstracts" : ""}.`,
      details: issues.map(([claim, result]) => formatCitationCheckResult(key, claim, result)).join("\n\n"),
    });
    return claims.map((claim, index) => formatCitationCheckResult(key, claim, results[index])).join("\n\n");
  } catch (error: any) {
    warn(ctx, `Citation ${key} could not be checked: ${error?.message ?? error}. No new support verdict was established.`);
    throw error;
  }
}
