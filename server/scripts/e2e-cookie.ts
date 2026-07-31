/**
 * End-to-end test of Overleaf cookie-sync mode against a faithful mock CE
 * instance: paste-link connect → local mirror → simulated agent edits →
 * approve (in-place doc edit/upload/delete replay) → collaborator sync-in →
 * dirty-skip → reject → expired-session handling.
 *
 * Requires the BlattBot server running on BLATTBOT_PORT (default 4560).
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { startMockOverleaf } from "./mock-overleaf.js";

const BASE = `http://127.0.0.1:${process.env.BLATTBOT_PORT ?? 4560}`;
const MOCK_PORT = 4599;
const REMOTE_ID = "aaaabbbbccccddddeeeeffff";
const COOKIE = "overleaf_session2=mock-session";

function step(name: string) {
  console.log(`\n=== ${name} ===`);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
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
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

async function main() {
  step("0. Start mock Overleaf CE");
  const mock = await startMockOverleaf(MOCK_PORT, REMOTE_ID);
  mock.files.set("main.tex", Buffer.from("\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n"));
  mock.files.set("refs.bib", Buffer.from("@article{a, title={A}, year={2000}}\n"));
  mock.files.set("figures/plot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  console.log("mock CE on", MOCK_PORT);

  step("1. Connect by pasted editor link + cookie");
  const project = await api<{ id: string; name: string; kind: string; mainTex?: string }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      url: `http://127.0.0.1:${MOCK_PORT}/project/${REMOTE_ID}`,
      cookie: COOKIE,
    }),
  });
  console.log("project:", project.id, "name:", project.name, "kind:", project.kind);
  assert(project.kind === "overleaf", "detected cookie mode from the pasted link");
  assert(project.name === "Mock Thesis", "project name came from the Overleaf dashboard");
  assert(project.mainTex === "main.tex", "main.tex detected");

  const dir = join(homedir(), ".local/share/blattbot/projects", project.id);
  const gitLog = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
  assert(gitLog.includes("Initial sync from Overleaf"), "local mirror committed the initial sync");
  assert(readFileSync(join(dir, "figures/plot.png")).length === 4, "binary file synced");

  step("2. Simulated agent edits (modify, add-in-subfolder, delete)");
  writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello, edited!\n\\end{document}\n");
  mkdirSync(join(dir, "chapters"), { recursive: true });
  writeFileSync(join(dir, "chapters/outro.tex"), "\\section{Outro}\n");
  rmSync(join(dir, "refs.bib"));
  const { diff } = await api<{ diff: string }>(`/api/projects/${project.id}/diff`);
  assert(diff.includes("Hello, edited!"), "diff shows the modification");
  assert(diff.includes("chapters/outro.tex"), "diff shows the new subfolder file");
  assert(diff.includes("refs.bib"), "diff shows the deletion");

  step("3. Approve → replay onto Overleaf");
  const approve = await api<{
    pushed: boolean;
    uploaded: string[];
    updatedInPlace?: string[];
    deleted: string[];
    warnings: string[];
  }>(
    `/api/projects/${project.id}/approve`,
    { method: "POST", body: JSON.stringify({ message: "cookie e2e" }) },
  );
  console.log("approve:", JSON.stringify(approve));
  assert(approve.pushed, "approve reported pushed");
  assert(approve.uploaded.includes("main.tex"), "modified file landed remotely");
  assert((approve.updatedInPlace ?? []).includes("main.tex"), "modified doc was edited in place over OT");
  assert(approve.uploaded.includes("chapters/outro.tex"), "subfolder file uploaded with relativePath");
  assert(approve.deleted.includes("refs.bib"), "deleted file removed server-side");
  assert((approve.warnings ?? []).length === 0, `no warnings, got: ${JSON.stringify(approve.warnings)}`);

  assert(
    mock.files.get("main.tex")?.toString().includes("Hello, edited!"),
    "mock server now has the edited main.tex",
  );
  assert(mock.files.has("chapters/outro.tex"), "mock server has the subfolder file");
  assert(!mock.files.has("refs.bib"), "mock server no longer has refs.bib");
  assert(mock.deletes.includes("refs.bib"), "delete endpoint was used for refs.bib");
  assert(!mock.deletes.includes("main.tex"), "in-place edit never deleted the main.tex entity");
  assert((mock.docVersions.get("main.tex") ?? 0) === 1, "in-place edit bumped the doc's OT version");

  step("4. Collaborator edit lands via sync-in");
  mock.files.set("main.tex", Buffer.from("\\documentclass{article}\n\\begin{document}\nCollaborator was here.\n\\end{document}\n"));
  await api(`/api/projects/${project.id}/sync`, { method: "POST" });
  assert(
    readFileSync(join(dir, "main.tex"), "utf8").includes("Collaborator was here"),
    "local mirror picked up the collaborator edit",
  );
  const log2 = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
  assert(log2.split("\n")[0].includes("Sync from Overleaf"), "sync-in became a commit");

  step("5. Dirty working tree skips refresh (agent edits are never clobbered)");
  writeFileSync(join(dir, "main.tex"), "LOCAL PENDING EDIT\n");
  mock.files.set("main.tex", Buffer.from("SERVER MOVED ON\n"));
  const syncResult = await api<{ ok: boolean; output: string }>(`/api/projects/${project.id}/sync`, { method: "POST" });
  console.log("sync while dirty:", syncResult.output);
  assert(readFileSync(join(dir, "main.tex"), "utf8").includes("LOCAL PENDING EDIT"), "pending edit untouched");
  await api(`/api/projects/${project.id}/reject`, { method: "POST" });
  const clean = await api<{ diff: string }>(`/api/projects/${project.id}/diff`);
  assert(!clean.diff.trim(), "reject restored a clean tree");

  step("6. Expired session surfaces a clear error");
  mock.authOk = false;
  let authError = "";
  try {
    await api(`/api/projects/${project.id}/sync`, { method: "POST" });
  } catch (err: any) {
    authError = err.message;
  }
  console.log("auth error:", authError);
  assert(/cookie|session/i.test(authError), "error tells the user to refresh the cookie");
  mock.authOk = true;

  step("7. Cleanup");
  await api(`/api/projects/${project.id}`, { method: "DELETE" });
  await mock.close();

  console.log("\n✅ COOKIE-SYNC E2E PASSED");
}

main().catch((err) => {
  console.error("\n❌ COOKIE-SYNC E2E FAILED:", err.message);
  process.exit(1);
});
