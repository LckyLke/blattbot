/**
 * Start listening, or explain why the server cannot. A busy port gets a
 * clear message instead of a stack trace; when the process holding it is
 * another BlattBot, that instance is opened instead and this one exits 0.
 *
 * Kept free of other BlattBot imports: the CLI loads it before the server.
 */
import { spawn } from "node:child_process";

interface Listener {
  listen(opts: { port: number; host: string }): Promise<unknown>;
}

let openOnConflict = false;

/** The CLI turns this on (unless --no-open); `npm run dev` leaves it off. */
export function setOpenBrowserOnConflict(open: boolean): void {
  openOnConflict = open;
}

/** Best-effort: open `url` in the default browser. Never throws. */
export function openBrowser(url: string): void {
  try {
    const [cmd, ...args] =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort */
  }
}

/**
 * Whether a BlattBot server answers on 127.0.0.1:`port`. With the matching
 * token /api/health returns { ok: true }; an instance with another data dir
 * (another token) still identifies itself in its 401 reply.
 */
export async function blattbotAnswers(port: number, token?: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (res.ok) return body?.ok === true;
    return res.status === 401 && typeof body?.error === "string" && body.error.includes("BlattBot");
  } catch {
    return false;
  }
}

/** What to tell the user when listening failed, and how to exit. */
export async function explainListenError(
  err: unknown,
  port: number,
  token?: string,
): Promise<{ message: string; exitCode: number; open?: string }> {
  const url = `http://127.0.0.1:${port}`;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    if (await blattbotAnswers(port, token)) {
      return openOnConflict
        ? { message: `BlattBot is already running at ${url}. Opening it in your browser.`, exitCode: 0, open: url }
        : { message: `BlattBot is already running at ${url}.`, exitCode: 0 };
    }
    return {
      message: `Port ${port} is busy. Is BlattBot already running? Open ${url} or use --port <n> (env BLATTBOT_PORT) to pick another port.`,
      exitCode: 1,
    };
  }
  if (code === "EACCES") {
    return { message: `Not allowed to listen on port ${port}. Use --port <n> (env BLATTBOT_PORT) with a port above 1023.`, exitCode: 1 };
  }
  return { message: `Could not start the server on ${url}: ${(err as Error)?.message ?? err}`, exitCode: 1 };
}

/** app.listen on loopback; on failure print the explanation and exit. */
export async function listenOrExit(app: Listener, port: number, token?: string): Promise<void> {
  try {
    await app.listen({ port, host: "127.0.0.1" });
  } catch (err) {
    const { message, exitCode, open } = await explainListenError(err, port, token);
    (exitCode === 0 ? console.log : console.error)(message);
    if (open) openBrowser(open);
    process.exit(exitCode);
  }
}
