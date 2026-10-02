import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blattbot-git-credentials-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("answers git's auth challenge from the environment, ignoring configured helpers", async () => {
  const { remoteAuth } = await import("../src/git.js");
  const auth = remoteAuth("olp_secret_token");
  const out = execFileSync("git", [...auth.args, "credential", "fill"], {
    input: "protocol=https\nhost=git.overleaf.com\npath=abc123\n\n",
    env: { ...process.env, ...auth.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
  });
  expect(out).toContain("username=git");
  expect(out).toContain("password=olp_secret_token");
  expect(remoteAuth(undefined)).toEqual({ args: [], env: {} });
});

it("moves a token out of an old clone's remote URL into the project record", async () => {
  const config = await import("../src/config.js");
  const sync = await import("../src/sync.js");
  const project = config.addProject({ name: "Old clone", gitUrl: "https://git.overleaf.com/abc123", kind: "git" });
  const dir = config.projectDir(project.id);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://git:olp_old%2Btoken@git.overleaf.com/abc123"]);

  await sync.moveRemoteCredentials(project);
  expect(execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim())
    .toBe("https://git.overleaf.com/abc123");
  expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain("olp_old");
  expect(config.getProject(project.id)?.token).toBe("olp_old+token");

  // Idempotent, and an existing token is never replaced.
  await sync.moveRemoteCredentials(project);
  expect(config.getProject(project.id)?.token).toBe("olp_old+token");
});

/** Smart-HTTP git server (git http-backend over CGI) that demands Basic auth. */
async function authedGitServer(projectRoot: string, user: string, password: string) {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const backend = join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git-http-backend");
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const cgi = spawn(backend, [], {
      env: {
        ...process.env, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: user,
        REQUEST_METHOD: req.method ?? "GET", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: req.headers["content-length"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (c) => chunks.push(c));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of out.subarray(0, split).toString().split("\r\n")) {
        const [k, ...v] = line.split(": ");
        if (k.toLowerCase() === "status") status = Number(v.join(": ").split(" ")[0]);
        else headers[k] = v.join(": ");
      }
      res.writeHead(status, headers).end(out.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

// The CGI test server is POSIX-only plumbing; the helper itself is covered on
// every OS by the `git credential fill` test above.
it.skipIf(process.platform === "win32")("clones, pulls and pushes through an authenticated remote without storing the token", async () => {
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  const served = join(root, "served");
  mkdirSync(served);
  run(served, "init", "-q", "--bare", "-b", "main", "paper.git");
  run(join(served, "paper.git"), "config", "http.receivepack", "true");
  const seed = join(root, "seed");
  run(root, "init", "-q", "-b", "main", seed);
  run(seed, "-c", "user.name=F", "-c", "user.email=f@x", "commit", "-q", "--allow-empty", "-m", "seed");
  run(seed, "push", "-q", join(served, "paper.git"), "main");
  const server = await authedGitServer(served, "git", "olp_live_token");
  try {
    const git = await import("../src/git.js");
    const dir = join(root, "clone");
    await expect(git.clone(`${server.url}/paper.git`, "wrong", dir)).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
    await git.clone(`${server.url}/paper.git`, "olp_live_token", dir);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain("olp_live_token");
    await git.pull(dir, "olp_live_token");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "main.tex"), "Hello\n");
    await git.stageAll(dir);
    await git.commitStagedExcept(dir, "edit", []);
    expect(await git.pushHead(dir, "olp_live_token")).toEqual({ pushed: true });
    expect(run(join(served, "paper.git"), "show", "main:main.tex")).toBe("Hello\n");
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain("olp_live_token");
  } finally {
    server.close();
  }
}, 30_000);
