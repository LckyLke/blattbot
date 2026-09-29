import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { synthesizeUntrackedDiff } from "./livediff.js";

const execFileP = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly command: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function gitWithEnv(
  cwd: string | undefined,
  extraEnv: Record<string, string>,
  args: string[],
): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        ...extraEnv,
      },
    });
    return stdout;
  } catch (err: any) {
    throw new GitError(
      `git ${args[0]} failed: ${String(err.stderr ?? err.message).trim()}`,
      String(err.stderr ?? ""),
      `git ${args.join(" ")}`,
    );
  }
}

async function git(cwd: string | undefined, ...args: string[]): Promise<string> {
  return gitWithEnv(cwd, {}, args);
}

/**
 * git with GIT_LITERAL_PATHSPECS=1 — for commands fed raw filenames (Overleaf
 * lets users create names like `fig[1].png`; as glob pathspecs those would
 * also match OTHER files, e.g. fig1.png, silently sweeping unrelated pending
 * edits into commits/checkouts).
 */
async function gitLiteral(cwd: string, ...args: string[]): Promise<string> {
  return gitWithEnv(cwd, { GIT_LITERAL_PATHSPECS: "1" }, args);
}

/**
 * Inject credentials into an https git URL. Overleaf's git bridge authenticates
 * as user "git" with the token as password. Non-https URLs (local paths, ssh)
 * are returned unchanged.
 */
export function authedUrl(gitUrl: string, token?: string): string {
  if (!token || !gitUrl.startsWith("https://")) return gitUrl;
  const u = new URL(gitUrl);
  u.username = "git";
  u.password = token;
  return u.toString();
}

export async function clone(gitUrl: string, token: string | undefined, dir: string): Promise<void> {
  // autocrlf=false: mirrors must stay byte-faithful — Windows' default CRLF
  // conversion would silently rewrite every file pushed back to Overleaf.
  await git(undefined, "-c", "core.autocrlf=false", "clone", authedUrl(gitUrl, token), dir);
  await git(dir, "config", "core.autocrlf", "false");
  // Identity for commits made through BlattBot.
  await git(dir, "config", "user.name", "BlattBot");
  await git(dir, "config", "user.email", "blattbot@localhost");
}

export async function pull(dir: string): Promise<string> {
  return git(dir, "pull", "--rebase", "--autostash");
}

/** Autostash can leave conflicts even when `git pull` exits successfully. */
export async function unmergedPaths(dir: string): Promise<string[]> {
  return (await git(dir, "diff", "--name-only", "--diff-filter=U", "-z")).split("\0").filter(Boolean);
}

/**
 * Diff of the working tree against HEAD, with untracked files included
 * via intent-to-add so brand-new files show up as additions.
 */
export async function workingDiff(dir: string): Promise<string> {
  await git(dir, "add", "--all", "--intent-to-add");
  return git(dir, "diff", "HEAD");
}

export async function hasChanges(dir: string): Promise<boolean> {
  const status = await git(dir, "status", "--porcelain");
  return status.trim().length > 0;
}

/**
 * Paths whose working-tree state differs from HEAD (modified, added, deleted,
 * or untracked). -z output: NUL-separated, unquoted even for non-ASCII names;
 * renames/copies carry the original path as an extra NUL field.
 * --untracked-files=all: without it git collapses a directory holding only
 * untracked files into one `?? dir/` record, hiding the files inside from
 * every consumer that compares full file paths (drift/conflict scans).
 */
export async function changedPaths(dir: string): Promise<string[]> {
  const out = await git(dir, "status", "--porcelain", "-z", "--untracked-files=all");
  const paths = new Set<string>();
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    paths.add(rec.slice(3));
    if (rec[0] === "R" || rec[0] === "C") {
      const orig = records[++i];
      if (orig) paths.add(orig);
    }
  }
  return [...paths];
}

export async function discard(dir: string): Promise<void> {
  await git(dir, "reset", "--hard", "HEAD");
  await git(dir, "clean", "-fd");
}

/**
 * Diff of one file against HEAD. Brand-new untracked files (invisible to
 * `git diff HEAD` until intent-to-add) get a synthesized all-added diff.
 */
export async function fileDiff(dir: string, relPath: string): Promise<string> {
  const out = await gitLiteral(dir, "diff", "HEAD", "--", relPath);
  if (out.trim()) return out;
  const status = (await gitLiteral(dir, "status", "--porcelain", "--", relPath)).trimEnd();
  if (!status.startsWith("??")) return out;
  try {
    return synthesizeUntrackedDiff(relPath, readFileSync(join(dir, relPath)));
  } catch {
    return out;
  }
}

/**
 * Discard the pending changes of a single path: restore tracked files from
 * HEAD; delete files that do not exist in HEAD (new files, including ones
 * only present as intent-to-add index entries).
 */
export async function discardPath(dir: string, relPath: string): Promise<void> {
  const inHead = (await gitLiteral(dir, "ls-tree", "--name-only", "HEAD", "--", relPath)).trim().length > 0;
  if (inHead) {
    await gitLiteral(dir, "checkout", "HEAD", "--", relPath);
    return;
  }
  // Drop any (intent-to-add) index entry, then make sure the file is gone.
  await gitLiteral(dir, "rm", "-f", "--ignore-unmatch", "--", relPath);
  rmSync(join(dir, relPath), { force: true });
}

/** Reverse-apply a unified patch (e.g. one reconstructed hunk) to the working tree. */
export async function applyReverse(dir: string, patch: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = execFile(
      "git",
      ["apply", "--reverse", "-"],
      {
        cwd: dir,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
      },
      (err: any, _stdout, stderr) => {
        if (err) {
          rejectPromise(
            new GitError(
              `git apply failed: ${String(stderr ?? err.message).trim()}`,
              String(stderr ?? ""),
              "git apply --reverse -",
            ),
          );
        } else {
          resolvePromise();
        }
      },
    );
    child.stdin!.end(patch);
  });
}

/** Stage everything, commit, rebase on the remote, and push. */
export async function commitAndPush(dir: string, message: string): Promise<{ pushed: boolean }> {
  await git(dir, "add", "--all");
  if (!(await hasChanges(dir))) return { pushed: false };
  await git(dir, "commit", "-m", message);
  // Pick up anything collaborators pushed while the agent was working.
  await git(dir, "pull", "--rebase");
  await git(dir, "push", "origin", "HEAD");
  return { pushed: true };
}

/** Initialize a fresh local-only repository (cookie-mode mirror). */
export async function initRepo(dir: string): Promise<void> {
  await git(undefined, "init", "-b", "master", dir);
  // Byte-faithful mirrors on every platform (see clone()).
  await git(dir, "config", "core.autocrlf", "false");
  await git(dir, "config", "user.name", "BlattBot");
  await git(dir, "config", "user.email", "blattbot@localhost");
}

/** Stage everything and commit. Returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, "add", "--all");
  if (!(await hasChanges(dir))) return false;
  await git(dir, "commit", "-m", message);
  return true;
}

/**
 * Stage and commit ONLY the given paths — pending changes to any other path
 * stay uncommitted. Returns false when those paths held nothing to commit.
 * Pathspecs are literal (Overleaf filenames may contain []*?), and `add -f`
 * stages remote files even when a committed .gitignore matches them (the
 * remote explicitly has them, so the mirror must too).
 */
export async function commitPaths(dir: string, message: string, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  await gitLiteral(dir, "add", "-f", "--", ...paths);
  const status = await gitLiteral(dir, "status", "--porcelain", "--", ...paths);
  if (!status.trim()) return false;
  await gitLiteral(dir, "commit", "-m", message, "--", ...paths);
  return true;
}

/** All paths tracked at HEAD ("/"-separated, like listFiles). */
export async function listHeadFiles(dir: string): Promise<string[]> {
  const out = await git(dir, "ls-tree", "-r", "--name-only", "-z", "HEAD");
  return out.split("\0").filter(Boolean);
}

/** Contents of a path as committed at HEAD, or null when HEAD does not have it. */
export async function showAtHead(dir: string, relPath: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileP("git", ["show", `HEAD:${relPath}`], {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Zip archive of the tree as committed at a rev (materializes old revisions). */
export async function archiveZip(dir: string, rev = "HEAD"): Promise<Buffer> {
  try {
    const { stdout } = await execFileP("git", ["archive", "--format=zip", rev], {
      cwd: dir,
      maxBuffer: 256 * 1024 * 1024,
      encoding: "buffer",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    });
    return stdout;
  } catch (err: any) {
    throw new GitError(
      `git archive failed: ${String(err.stderr ?? err.message).trim()}`,
      String(err.stderr ?? ""),
      `git archive --format=zip ${rev}`,
    );
  }
}

export async function diffNameStatus(dir: string, fromRef: string, toRef: string): Promise<string> {
  return git(dir, "diff", "--name-status", "-M", fromRef, toRef);
}

export async function revParse(dir: string, ref: string): Promise<string> {
  return (await git(dir, "rev-parse", ref)).trim();
}

export async function log(dir: string, count = 20): Promise<string> {
  return git(dir, "log", `--max-count=${count}`, "--pretty=format:%h %an %ad %s", "--date=relative");
}

export async function headRef(dir: string): Promise<string> {
  return (await git(dir, "rev-parse", "--short", "HEAD")).trim();
}
