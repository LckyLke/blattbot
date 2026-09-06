/** Small stdio JSON-RPC client for the installed Codex app server.
 * Protocol: https://developers.openai.com/codex/app-server
 * No model request is made during initialization, diagnostics, or model listing.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.js";

export const codexExecutable = () => process.env.BLATTBOT_CODEX_EXECUTABLE?.trim() || "codex";
export const codexWorkspace = () => join(DATA_DIR, "codex-workspace");

/** Resolve npm's Windows shim to its JS entry, avoiding cmd.exe quoting. */
export function codexCommand(executable = codexExecutable(), platform = process.platform, path = process.env.PATH ?? "") {
  if (/\.[cm]?js$/i.test(executable)) return { command: process.execPath, args: [executable] };
  if (platform === "win32") {
    const dirs = /[\\/]/.test(executable) ? [dirname(executable)] : path.split(";");
    for (const dir of dirs) {
      const entry = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if ((executable === "codex" || /codex\.cmd$/i.test(executable)) && existsSync(entry)) {
        return { command: process.execPath, args: [entry] };
      }
    }
  }
  return { command: executable, args: [] as string[] };
}

// Native execution stays read-only. All project access goes through BlattBot's
// validated dynamic tools. A neutral cwd also avoids loading project config.
export const CODEX_CONFIG: Record<string, unknown> = {
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.apply_patch_freeform": false,
  "features.apps": false,
  "features.plugins": false,
  "features.multi_agent": false,
  "features.js_repl": false,
  "features.code_mode": false,
  "features.hooks": false,
  "features.memories": false,
  "features.shell_snapshot": false,
  "tools.view_image": false,
  web_search: "disabled",
  project_doc_max_bytes: 0,
};

export class CodexClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stopped?: Error;
  private stderr = "";
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async (method) => {
    throw new Error(`Unsupported Codex request: ${method}`);
  };
  onFailure: (error: Error) => void = () => {};

  constructor() {
    mkdirSync(codexWorkspace(), { recursive: true });
    const args = ["app-server", "--listen", "stdio://"];
    for (const [key, value] of Object.entries(CODEX_CONFIG)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    const launch = codexCommand();
    this.child = spawn(launch.command, [...launch.args, ...args], {
      cwd: codexWorkspace(), stdio: "pipe", windowsHide: true,
      // Do not pass prompts or configuration through a shell. On Windows use
      // the native codex.exe (BLATTBOT_CODEX_EXECUTABLE can select its path).
      shell: false,
    });
    this.child.stderr.setEncoding("utf8").on("data", (s: string) => { this.stderr = (this.stderr + s).slice(-3000); });
    this.child.on("error", (e: NodeJS.ErrnoException) => this.fail(new Error(
      e.code === "ENOENT"
        ? "Codex was not found. Install @openai/codex, run codex login, then retry. Set BLATTBOT_CODEX_EXECUTABLE for a custom binary."
        : `Could not start Codex: ${e.message}`,
    )));
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("close", (code) => this.fail(new Error(`Codex exited (${code ?? "signal"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`)));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.method) {
        if (m.id !== undefined) {
          void this.onRequest(m.method, m.params ?? {}).then(
            (result) => this.send({ id: m.id, result }),
            (error) => this.send({ id: m.id, error: { code: -32603, message: error?.message ?? String(error) } }),
          );
        } else this.onNotification(m.method, m.params ?? {});
      } else {
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? "Codex request failed"));
        else p.resolve(m.result);
      }
    });
  }

  private send(message: unknown): void {
    if (!this.stopped && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.onFailure(error);
  }

  request(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<any> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Check codex login and update the Codex CLI.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "blattbot", title: "BlattBot", version: "0.4.2" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }

  /** Disable inherited MCPs individually: an empty table would merge with
   * the user's table and accidentally retain its tools. Never expose values. */
  async threadConfig(): Promise<Record<string, unknown>> {
    const { config } = await this.request("config/read", { includeLayers: false });
    const overrides = { ...CODEX_CONFIG };
    for (const name of Object.keys(config?.mcp_servers ?? {})) {
      overrides[`mcp_servers.${JSON.stringify(name)}.enabled`] = false;
    }
    return overrides;
  }

  close(): void {
    this.fail(new Error("Codex connection closed"));
    this.child.stdin.end();
    this.child.kill();
    const timer = setTimeout(() => { this.child.kill("SIGKILL"); }, 1000);
    timer.unref();
    this.child.once("close", () => clearTimeout(timer));
  }
}
