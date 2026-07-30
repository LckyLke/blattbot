/**
 * End-to-end test of the full BlattBot loop against a local bare git repo
 * that stands in for git.overleaf.com:
 *
 *   fixture repo → add project → real agent turn (edit + citation + compile)
 *   → diff appears → approve → push lands in the "Overleaf" remote.
 *
 * Requires the server to be running (BLATTBOT_PORT, default 4560).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const BASE = `http://127.0.0.1:${process.env.BLATTBOT_PORT ?? 4560}`;
const FIXTURE_ROOT = process.env.E2E_FIXTURE_DIR ?? "/tmp/blattbot-e2e";

function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" });
}

function step(name: string) {
  console.log(`\n=== ${name} ===`);
}

let authToken: string | null = null;
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (authToken === null) {
    authToken = ((await (await fetch(`${BASE}/api/bootstrap`)).json()) as { token: string }).token;
  }
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${authToken}`,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

const MAIN_TEX = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\title{A Sample Article}
\\author{Luke}
\\begin{document}
\\maketitle
\\section{Introduction}
Some introductory text about our topic.
\\section{Methods}
We describe our methods here.
\\end{document}
`;

async function main() {
  step("0. Health check");
  const health = await api<{ ok: boolean; engine: string | null }>("/api/health");
  console.log("health:", health);
  assert(health.ok, "server healthy");
  assert(health.engine, "a TeX engine is available");

  step("1. Build fixture: bare repo standing in for git.overleaf.com");
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const bare = join(FIXTURE_ROOT, "overleaf.git");
  const seed = join(FIXTURE_ROOT, "seed");
  sh(FIXTURE_ROOT, "git", "init", "--bare", "-b", "master", bare);
  sh(FIXTURE_ROOT, "git", "clone", bare, seed);
  writeFileSync(join(seed, "main.tex"), MAIN_TEX);
  sh(seed, "git", "-c", "user.name=Fixture", "-c", "user.email=f@x", "add", "-A");
  sh(seed, "git", "-c", "user.name=Fixture", "-c", "user.email=f@x", "commit", "-m", "initial");
  sh(seed, "git", "push", "origin", "HEAD");
  console.log("bare repo at", bare);

  step("2. Add project (clones from the fixture remote)");
  const project = await api<{ id: string; mainTex?: string }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "E2E Sample", gitUrl: bare }),
  });
  console.log("project:", project.id, "mainTex:", project.mainTex);
  assert(project.mainTex === "main.tex", "main.tex detected");

  step("3. Baseline compile");
  const compile1 = await api<{ ok: boolean; engine: string }>(`/api/projects/${project.id}/compile`, {
    method: "POST",
  });
  console.log("compile ok:", compile1.ok, "engine:", compile1.engine);
  assert(compile1.ok, "baseline project compiles");

  step("4. Agent turn: edit + citation + self-verified compile");
  const events: any[] = [];
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/ws?project=${project.id}`);
  const turnDone = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("agent turn timed out after 15 min")), 900_000);
    ws.on("message", (data) => {
      const ev = JSON.parse(String(data));
      events.push(ev);
      if (ev.type === "tool_use") console.log("  tool:", ev.name, ev.detail ?? "");
      if (ev.type === "error") console.log("  error:", ev.message);
      if (ev.type === "compile") {
        // final compile after the turn — this is the last broadcast
        clearTimeout(timeout);
        resolve();
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));

  await api(`/api/projects/${project.id}/chat`, {
    method: "POST",
    body: JSON.stringify({
      message:
        "Two tasks: (1) Change the article title from 'A Sample Article' to 'BlattBot Works'. " +
        "(2) In the Introduction, add one sentence noting that deep learning has transformed many fields, " +
        "citing the 2015 Nature review 'Deep learning' by LeCun, Bengio and Hinton (DOI 10.1038/nature14539). " +
        "Use your add_citation tool for the reference, set up \\bibliographystyle{plain} and \\bibliography as needed, " +
        "and verify the project compiles before you finish.",
    }),
  });
  await turnDone;
  ws.close();

  const turnEnd = events.find((e) => e.type === "turn_end");
  const diffEvent = events.filter((e) => e.type === "diff").pop();
  const compileEvent = events.filter((e) => e.type === "compile").pop();
  console.log("turn_end:", JSON.stringify(turnEnd));
  assert(turnEnd && !turnEnd.isError, "agent turn completed without error");
  assert(diffEvent?.diff?.trim(), "a diff was produced");
  assert(compileEvent?.ok, "project compiles after the agent's edits");

  const usedCitationTool = events.some(
    (e) => e.type === "tool_use" && String(e.name).includes("add_citation"),
  );
  const usedCompileTool = events.some(
    (e) => e.type === "tool_use" && String(e.name).includes("compile_latex"),
  );
  console.log("used add_citation:", usedCitationTool, "· used compile_latex:", usedCompileTool);
  assert(usedCitationTool, "agent used the citation pipeline");

  step("5. Verify diff content");
  const { diff } = await api<{ diff: string }>(`/api/projects/${project.id}/diff`);
  assert(diff.includes("BlattBot Works"), "diff contains the new title");
  assert(/\\cite\{/.test(diff), "diff contains a \\cite command");
  assert(diff.includes(".bib") || diff.includes("references"), "diff touches a bibliography file");
  console.log("diff summary:", diff.split("\n").filter((l) => l.startsWith("diff --git")).join(" | "));

  step("6. Bibliography endpoint sees the new entry");
  const bib = await api<{ entries: { key: string; doi: string | null }[] }>(
    `/api/projects/${project.id}/bib`,
  );
  console.log("bib entries:", bib.entries.map((e) => e.key).join(", "));
  assert(
    bib.entries.some((e) => e.doi?.toLowerCase().includes("10.1038/nature14539")),
    "the LeCun DOI is in the bibliography",
  );

  step("7. Approve → commit + push to the Overleaf stand-in");
  const approve = await api<{ ok: boolean; pushed: boolean }>(`/api/projects/${project.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ message: "e2e: title change + citation" }),
  });
  assert(approve.pushed, "changes were pushed");

  const bareLog = sh(FIXTURE_ROOT, "git", "--git-dir", bare, "log", "--oneline", "-5");
  console.log("remote log:\n" + bareLog.trim());
  assert(bareLog.includes("e2e: title change + citation"), "commit landed in the remote");
  const remoteFile = sh(FIXTURE_ROOT, "git", "--git-dir", bare, "show", "HEAD:main.tex");
  assert(remoteFile.includes("BlattBot Works"), "remote main.tex has the new title");

  step("8. Reject path: a junk edit can be discarded");
  const detail = await api<{ id: string }>(`/api/projects/${project.id}`);
  writeFileSync(join(process.env.HOME!, ".local/share/blattbot/projects", detail.id, "junk.txt"), "junk");
  const dirty = await api<{ diff: string }>(`/api/projects/${project.id}/diff`);
  assert(dirty.diff.includes("junk.txt"), "junk file appears in diff");
  await api(`/api/projects/${project.id}/reject`, { method: "POST" });
  const cleanDiff = await api<{ diff: string }>(`/api/projects/${project.id}/diff`);
  assert(!cleanDiff.diff.trim(), "working tree is clean after reject");

  console.log(`\n✅ E2E PASSED — cost of agent turn: $${turnEnd.costUsd?.toFixed(4) ?? "?"}`);
  console.log(`E2E_PROJECT_ID=${project.id}`);
}

main().catch((err) => {
  console.error("\n❌ E2E FAILED:", err.message);
  process.exit(1);
});
