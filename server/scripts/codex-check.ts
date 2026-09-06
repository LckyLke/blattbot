/** Real CLI/protocol check. Starts no turn and makes no inference request. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "blattbot-codex-check-"));
process.env.BLATTBOT_DATA_DIR = work;
const { codexStatus } = await import("../src/codexinfo.js");
const { CodexClient, codexWorkspace } = await import("../src/backends/codex-client.js");
const { codexTools, CODEX_SYSTEM_PROMPT } = await import("../src/backends/codex.js");
let client: InstanceType<typeof CodexClient> | undefined;
try {
  const status = await codexStatus(true);
  console.log(JSON.stringify({ available: status.available, authenticated: status.authenticated,
    models: status.models.length, defaultModel: status.defaultModel, message: status.message }));
  if (!status.available) throw new Error("Codex is unavailable");
  client = new CodexClient();
  await client.initialize();
  const config = await client.threadConfig();
  const result = await client.request("thread/start", {
    cwd: codexWorkspace(), sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
    config, baseInstructions: CODEX_SYSTEM_PROMPT, dynamicTools: codexTools(),
  });
  if (!result.thread?.id) throw new Error("Codex did not create the diagnostic thread");
  console.log("Codex accepted the thread configuration and BlattBot tool schemas. No agent turn was started.");
} finally {
  client?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
