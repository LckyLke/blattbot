/** Source gaps reach the chat directly, independent of the model's final answer. */
import { formatCitationCheckResult, formatPaperReadResult, readPaper, verifyCitationSupport, type PaperReadOptions } from "../papers.js";
import type { BackendTurnContext } from "./types.js";

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
    const result = await readPaper(ctx.project.id, ctx.dir, key, { ...opts, contextDirs: ctx.contextDirs });
    if (result.excerpt?.hasText) (ctx.paperReads ??= new Set()).add(key);
    if (result.basis !== "full_text") {
      warn(ctx, `${result.title} (${key}): ${result.basis === "abstract" ? "Only the abstract is available." : "No readable source is available."} ${result.limitations.join(" ")}`);
    } else if (result.limitations.some((line) => line.startsWith("No extractable text on pages"))) {
      warn(ctx, `${result.title} (${key}): ${result.limitations.join(" ")}`);
    }
    return formatPaperReadResult(result);
  } catch (error: any) {
    warn(ctx, `Could not read paper ${key}: ${error?.message ?? error}. Its content has not been established by this read. Provide the correct bibliography key and a readable PDF or relevant passages.`);
    throw error;
  }
}

export async function verifyPaperTool(ctx: BackendTurnContext, key: string, claim: string): Promise<string> {
  try {
    const result = await verifyCitationSupport(ctx.project.id, ctx.dir, key, claim, { contextDirs: ctx.contextDirs });
    const report = formatCitationCheckResult(key, claim, result);
    if (result.basis !== "full_text" || result.truncated || result.verdict !== "supported") warn(ctx, report);
    return report;
  } catch (error: any) {
    warn(ctx, `Citation ${key} could not be checked: ${error?.message ?? error}. Claim: ${claim}`);
    throw error;
  }
}
