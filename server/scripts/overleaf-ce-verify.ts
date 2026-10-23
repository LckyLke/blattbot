/**
 * Checks BlattBot's Overleaf sync against a REAL Overleaf server, for example
 * Overleaf Community Edition in Docker (see CONTRIBUTING.md). The unit tests
 * use a hand-written mock; this script catches where the mock and the real
 * protocol differ. A second realtime session of the same account plays the
 * co-author who edits and comments in the Overleaf editor.
 *
 *   BLATTBOT_CE_URL=http://127.0.0.1:8090 \
 *   BLATTBOT_CE_COOKIE='overleaf.sid=…' \
 *   npx tsx scripts/overleaf-ce-verify.ts          (from server/)
 *
 * Each run creates one new project in that account and leaves it there.
 * Exits non-zero when a check fails.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.BLATTBOT_CE_URL?.replace(/\/+$/, "");
const cookie = process.env.BLATTBOT_CE_COOKIE;
if (!base || !cookie) {
  console.error("Set BLATTBOT_CE_URL and BLATTBOT_CE_COOKIE (an overleaf.sid=… session cookie).");
  process.exit(2);
}

process.env.BLATTBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "blattbot-ce-verify-"));
const config = await import("../src/config.js");
const git = await import("../src/git.js");
const sync = await import("../src/sync.js");
const { OverleafClient, OverleafFeatureError, buildTree, generateIdSeed } = await import("../src/overleaf/olclient.js");
const { unpackZip } = await import("../src/overleaf/olsync.js");
const { fetchRemoteReview, buildReview } = await import("../src/overleaf/comments.js");
const { projectMetaFromTree } = await import("../src/overleaf/metadata.js");
const { computeTextOpHunks, historyTextOperation } = await import("../src/overleaf/ot.js");

const client = new OverleafClient(base, cookie);
const LINES = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the paper.`);
const MAIN = `\\documentclass{article}\n\\begin{document}\n${LINES.join("\n")}\n\\end{document}\n`;
const withLine = (text: string, n: number, next: string) => text.replace(`Line ${n} of the paper.`, next);

let failures = 0;
/** Thrown by a check that does not apply to this instance (reported, not failed). */
class Skip extends Error {}
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err: any) {
    if (err instanceof Skip) {
      console.log(`– ${name} — skipped: ${err.message}`);
      return;
    }
    failures++;
    console.log(`✗ ${name} — ${err?.message ?? err}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Setup: a fresh project on Overleaf, mirrored locally ----
const src = mkdtempSync(join(tmpdir(), "blattbot-ce-src-"));
writeFileSync(join(src, "main.tex"), MAIN);
writeFileSync(join(src, "refs.bib"), "@article{a, title={A}, year={2000}}\n");
const name = `BlattBot CE check ${new Date().toISOString().replace(/[:.]/g, "-")}`;
const published = await sync.publishTree(client, name, src, "main.tex");
const remoteId = published.remoteProjectId;
const project = config.addProject({
  name,
  gitUrl: `${base}/project/${remoteId}`,
  kind: "overleaf",
  overleafBaseUrl: base,
  overleafProjectId: remoteId,
  cookie,
});
const dir = config.projectDir(project.id);
await git.initRepo(dir);
console.log(`Project ${remoteId} (${base}/project/${remoteId})`);

const fresh = () => config.getProject(project.id)!;
const remoteText = async (path: string) => unpackZip(await client.downloadZip(remoteId)).get(path)?.toString("utf8");
const local = (path: string) => readFileSync(join(dir, path), "utf8");
const writeLocal = (path: string, text: string) => writeFileSync(join(dir, path), text);

/** The co-author: edit a doc in place over a separate realtime session. */
async function coauthorEdit(path: string, edit: (text: string) => string): Promise<void> {
  const s = await client.connectRealtime(remoteId);
  try {
    const id = buildTree(s.project).entities.get(path)!.id;
    const doc = await s.joinDoc(id);
    const text = doc.lines.join("\n");
    const next = edit(text);
    if (doc.type === "history-ot") {
      await s.applyHistoryOtUpdate(id, historyTextOperation(doc.historyContent ?? text, doc.hiddenSpans ?? [], next), doc.version);
    } else {
      await s.applyOtUpdate(id, computeTextOpHunks(text, next), doc.version);
    }
    const after = await s.joinDoc(id);
    if (s.otUpdateError) throw s.otUpdateError;
    assert(after.lines.join("\n") === next, "co-author edit did not land");
  } finally {
    s.close();
  }
}

/** Whether the instance has Overleaf's comment API (Community Edition does not). */
let threadsApi = true;

/** The co-author: comment on `quote` (thread message when the API exists, then the comment op). */
async function coauthorComment(path: string, quote: string, message: string): Promise<string> {
  const threadId = `${generateIdSeed()}000001`;
  try {
    await client.postThreadMessage(remoteId, threadId, message);
  } catch (err) {
    if (!(err instanceof OverleafFeatureError)) throw err;
    threadsApi = false;
  }
  const s = await client.connectRealtime(remoteId);
  try {
    const id = buildTree(s.project).entities.get(path)!.id;
    const doc = await s.joinDoc(id);
    const p = doc.lines.join("\n").indexOf(quote);
    assert(p >= 0, `quote not found: ${quote}`);
    await s.applyOtUpdate(id, [{ c: quote, p, t: threadId } as any], doc.version);
    await s.joinDoc(id);
    if (s.otUpdateError) throw s.otUpdateError;
  } finally {
    s.close();
  }
  return threadId;
}

async function docId(path: string): Promise<string> {
  return (await client.joinProjectTree(remoteId)).entities.get(path)!.id;
}

async function docState(path: string) {
  const s = await client.connectRealtime(remoteId);
  try {
    return await s.joinDoc(buildTree(s.project).entities.get(path)!.id);
  } finally {
    s.close();
  }
}

// ---- Checks ----
await check("initial sync mirrors the project", async () => {
  const r = await sync.syncIn(fresh());
  assert(r.changed, "no sync commit");
  assert(local("main.tex") === MAIN, "main.tex differs from what was published");
  return `remoteLastUpdated ${fresh().remoteLastUpdated ?? "(none)"}`;
});

await check("doc type and project metadata", async () => {
  const doc = await docState("main.tex");
  const meta = projectMetaFromTree(await client.joinProjectTree(remoteId));
  assert(meta.compiler === "pdflatex", `compiler ${meta.compiler}`);
  assert(meta.rootDocPath === "main.tex", `root doc ${meta.rootDocPath}`);
  return `doc type ${doc.type}, compiler ${meta.compiler}, root doc ${meta.rootDocPath ?? "(none)"}`;
});

await check("quick sync skips the download when nothing changed", async () => {
  const r = await sync.syncIn(fresh(), { quick: true });
  assert(r.skipped === true, `not skipped: ${JSON.stringify(r)}`);
});

await check("sync merges a co-author edit under a local pending edit", async () => {
  writeLocal("main.tex", withLine(local("main.tex"), 40, "Line 40, edited locally."));
  await coauthorEdit("main.tex", (t) => withLine(t, 3, "Line 3, edited by a co-author."));
  const r = await sync.syncIn(fresh(), { quick: true });
  assert(!r.skipped, "quick sync skipped a real change");
  assert(r.rebased?.includes("main.tex"), `not rebased: ${JSON.stringify(r)}`);
  const text = local("main.tex");
  assert(text.includes("Line 40, edited locally.") && text.includes("Line 3, edited by a co-author."), "worktree lacks one side");
});

await check("approve pushes the merged file", async () => {
  const r = await sync.approve(fresh(), "Agent: edit line 40");
  assert(r.pushed, "not pushed");
  const remote = await remoteText("main.tex");
  assert(remote === local("main.tex"), "Overleaf differs from the approved text");
  assert((await git.workingDiff(dir)) === "", "changes left pending");
  return `in place: ${(r.updatedInPlace ?? []).join(", ")}`;
});

await check("approve merges a co-author edit made after the last sync", async () => {
  writeLocal("main.tex", withLine(local("main.tex"), 50, "Line 50, edited locally."));
  await coauthorEdit("main.tex", (t) => withLine(t, 10, "Line 10, edited by a co-author."));
  const r = await sync.approve(fresh(), "Agent: edit line 50");
  assert(r.pushed && r.mergedRemote?.includes("main.tex"), `result ${JSON.stringify(r)}`);
  const remote = (await remoteText("main.tex")) ?? "";
  assert(remote.includes("Line 50, edited locally.") && remote.includes("Line 10, edited by a co-author."), "a side is missing on Overleaf");
});

await check("same-line edits are refused, then resolved per file", async () => {
  writeLocal("main.tex", withLine(local("main.tex"), 20, "Line 20, local version."));
  await coauthorEdit("main.tex", (t) => withLine(t, 20, "Line 20, co-author version."));
  let refused = false;
  try {
    await sync.approve(fresh(), "Agent: conflicting edit");
  } catch (err) {
    refused = err instanceof sync.ApproveConflictError;
  }
  assert(refused, "approve did not refuse the overlap");
  assert(((await remoteText("main.tex")) ?? "").includes("Line 20, co-author version."), "Overleaf lost the co-author edit");
  await sync.resolveConflicts(fresh(), ["main.tex"], "overleaf");
  assert(local("main.tex").includes("Line 20, co-author version."), "keep-Overleaf did not take Overleaf's version");
});

let threadId = "";
await check("co-author comments are listed with their messages", async () => {
  threadId = await coauthorComment("main.tex", "Line 30 of the paper.", "Please cite a source here.");
  await sync.syncIn(fresh());
  const review = buildReview(await fetchRemoteReview(client, remoteId), dir);
  const thread = review.threads.find((t) => t.id === threadId);
  assert(thread, `thread missing: ${JSON.stringify(review.threads.map((t) => t.quote))}`);
  assert(thread.quote === "Line 30 of the paper.", `quote ${thread.quote}`);
  if (!threadsApi) {
    assert(!review.threadsAvailable && review.warnings.length > 0, "no notice that messages are unavailable");
    return `no comment API on this instance: listed without messages (Overleaf line ${thread.line}); notice: ${review.warnings[0]}`;
  }
  assert(thread.messages.some((m) => m.content === "Please cite a source here."), "message missing");
  return `Overleaf line ${thread.line}, local line ${thread.localLine}`;
});

await check("reply and resolve reach Overleaf", async () => {
  if (!threadsApi) throw new Skip("this instance has no comment API");
  await client.postThreadMessage(remoteId, threadId, "Added one.");
  await client.setThreadResolved(remoteId, await docId("main.tex"), threadId, true);
  const threads = await client.getThreads(remoteId);
  const t = threads.get(threadId);
  assert(t && t.messages.length === 2 && t.resolved, `thread ${JSON.stringify(t)}`);
});

await check("a normal push keeps a comment between two edits", async () => {
  if (threadsApi) await client.setThreadResolved(remoteId, await docId("main.tex"), threadId, false);
  writeLocal("main.tex", withLine(withLine(local("main.tex"), 25, "Line 25, edited."), 35, "Line 35, edited."));
  const r = await sync.approve(fresh(), "Agent: edit lines 25 and 35");
  assert(r.pushed, "not pushed");
  const doc = await docState("main.tex");
  const c = doc.ranges.comments.find((x) => x.threadId === threadId);
  assert(c && c.quote === "Line 30 of the paper.", `comment ${JSON.stringify(doc.ranges.comments)}`);
  const text = doc.lines.join("\n");
  assert(text.slice(c.offset, c.offset + c.quote.length) === c.quote, "comment range moved off its text");
});

await check("tracked-change push is recorded", async () => {
  config.updateProject(project.id, { settings: { ...(fresh().settings ?? {}), trackChanges: true } });
  writeLocal("main.tex", withLine(local("main.tex"), 45, "Line 45, a tracked edit."));
  const r = await sync.approve(fresh(), "Agent: tracked edit");
  assert(r.pushed, "not pushed");
  const notRecorded = (r.warnings ?? []).filter((w) => /did not record tracked changes/.test(w));
  const noReview = (r.warnings ?? []).some((w) => /no review features/.test(w));
  const doc = await docState("main.tex");
  config.updateProject(project.id, { settings: { ...(fresh().settings ?? {}), trackChanges: false } });
  assert(notRecorded.length === 0, notRecorded.join("; "));
  assert(doc.ranges.changes.length > 0, "no tracked change in the doc's ranges");
  assert(noReview === !threadsApi, `review warning ${noReview}, comment API ${threadsApi}`);
  return `${doc.ranges.changes.length} tracked change(s)${noReview ? "; warned that the instance has no review features" : ""}`;
});

await check("history label names the push", async () => {
  config.updateProject(project.id, { settings: { ...(fresh().settings ?? {}), labelPushes: true } });
  writeLocal("main.tex", withLine(local("main.tex"), 55, "Line 55, edited."));
  const r = await sync.approve(fresh(), "Agent: labelled edit");
  config.updateProject(project.id, { settings: { ...(fresh().settings ?? {}), labelPushes: false } });
  assert(r.pushed, "not pushed");
  assert(r.historyLabel === "Agent: labelled edit (BlattBot)", `label ${r.historyLabel}; warnings ${JSON.stringify(r.warnings)}`);
  const res = await fetch(`${base}/project/${remoteId}/labels`, { headers: { Cookie: cookie, Accept: "application/json" } });
  const labels = (await res.json()) as { comment: string }[];
  assert(labels.some((l) => l.comment === r.historyLabel), `labels ${JSON.stringify(labels)}`);
});

await check("Overleaf's compiler builds the pushed state", async () => {
  const r = await sync.remoteCompile(fresh());
  assert(r.status === "success" && r.pdf, `remote compile: ${r.status} ${r.logTail?.slice(-300) ?? ""}`);
  return `${r.pdf.length} byte PDF`;
});

console.log(failures === 0 ? "All Overleaf checks passed." : `${failures} Overleaf check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
