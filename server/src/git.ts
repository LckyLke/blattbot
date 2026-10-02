import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
 * Credentials for ONE remote command. Overleaf's git bridge authenticates as
 * user "git" with the token as password. The token is never written into the
 * remote URL in .git/config, where an agent's shell could read it with
 * `git remote -v`: a credential helper given on the command line answers the
 * auth challenge from the environment instead. The empty helper first clears
 * any configured ones, so the token is not saved to the user's keychain.
 */
export function remoteAuth(token?: string): { args: string[]; env: Record<string, string> } {
  if (!token) return { args: [], env: {} };
  return {
    args: ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=git; echo "password=$BLATTBOT_GIT_TOKEN"; }; f'],
    env: { BLATTBOT_GIT_TOKEN: token },
  };
}

/**
 * Older BlattBot versions cloned with the token inside the remote URL. Rewrite
 * such a URL without its credentials; returns the password it held, if any.
 */
export async function stripRemoteCredentials(dir: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL((await git(dir, "remote", "get-url", "origin")).trim());
  } catch {
    return null; // no origin, or not a URL (local path, scp-style ssh)
  }
  if (!url.password) return null;
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  await git(dir, "remote", "set-url", "origin", url.toString());
  return password;
}

export async function clone(gitUrl: string, token: string | undefined, dir: string): Promise<void> {
  const auth = remoteAuth(token);
  // autocrlf=false: mirrors must stay byte-faithful — Windows' default CRLF
  // conversion would silently rewrite every file pushed back to Overleaf.
  await gitWithEnv(undefined, auth.env, [...auth.args, "-c", "core.autocrlf=false", "clone", gitUrl, dir]);
  await git(dir, "config", "core.autocrlf", "false");
  // Identity for commits made through BlattBot.
  await git(dir, "config", "user.name", "BlattBot");
  await git(dir, "config", "user.email", "blattbot@localhost");
}

export async function pull(dir: string, token?: string): Promise<string> {
  const auth = remoteAuth(token);
  return gitWithEnv(dir, auth.env, [...auth.args, "pull", "--rebase", "--autostash"]);
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

/** Move HEAD back to `ref`, keeping the undone commits' changes staged and in the worktree. */
export async function resetSoft(dir: string, ref: string): Promise<void> {
  await git(dir, "reset", "--soft", ref);
}

/**
 * Commit what is staged, except `paths`: those are unstaged first and stay as
 * pending worktree changes. Returns false when nothing else was staged.
 */
export async function commitStagedExcept(dir: string, message: string, paths: string[]): Promise<boolean> {
  if (paths.length > 0) await gitLiteral(dir, "reset", "-q", "--", ...paths);
  if (!(await git(dir, "diff", "--cached", "--name-only")).trim()) return false;
  await git(dir, "commit", "-m", message);
  return true;
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
  await applyPatch(dir, patch, ["--reverse"]);
}

/** `git apply <flags> -` with the patch on stdin (e.g. --cached to stage one hunk). */
export async function applyPatch(dir: string, patch: string, flags: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = execFile(
      "git",
      ["apply", ...flags, "-"],
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
              `git apply ${flags.join(" ")} -`,
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

/**
 * Rebase the commit just made onto the remote and push it. Changes still
 * pending in the worktree (a partial approval) ride along in the autostash.
 */
export async function pushHead(dir: string, token?: string): Promise<{ pushed: true; warnings?: string[] }> {
  const auth = remoteAuth(token);
  try {
    // Pick up anything collaborators pushed while the agent was working.
    await gitWithEnv(dir, auth.env, [...auth.args, "pull", "--rebase", "--autostash"]);
    await gitWithEnv(dir, auth.env, [...auth.args, "push", "origin", "HEAD"]);
  } catch (err) {
    // Never leave a half-done rebase, or an unpushed commit that later
    // approvals would report as "nothing to push": un-commit so the changes
    // stay pending. HEAD~1 is the parent of our commit, rebased or not.
    await git(dir, "rebase", "--abort").catch(() => {});
    await resetSoft(dir, "HEAD~1");
    throw err;
  }
  const conflicted = await unmergedPaths(dir);
  return conflicted.length > 0
    ? { pushed: true, warnings: [`Pushed. Your other pending edits conflict with the remote's changes in: ${conflicted.join(", ")} — resolve the conflict markers there.`] }
    : { pushed: true };
}

/** Clear the index back to HEAD (staged leftovers, intent-to-add entries); the worktree is untouched. */
export async function resetIndex(dir: string): Promise<void> {
  await git(dir, "reset", "-q");
}

/** Stage the whole worktree, like `git add --all` (ignored files stay out). */
export async function stageAll(dir: string): Promise<void> {
  await git(dir, "add", "--all");
}

/** Stage these paths exactly as they are in the worktree (deletions included). */
export async function stagePaths(dir: string, paths: string[]): Promise<void> {
  if (paths.length > 0) await gitLiteral(dir, "add", "-A", "--", ...paths);
}

/** Paths staged relative to HEAD; a rename counts as its two paths. */
export async function stagedPaths(dir: string): Promise<string[]> {
  return (await git(dir, "diff", "--cached", "--name-only", "--no-renames", "-z")).split("\0").filter(Boolean);
}

/** A file's bytes at `rev` (null = the index), or null when it has no such file. */
export async function readBlob(dir: string, rev: string | null, path: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileP("git", ["show", `${rev ?? ""}:${path}`], {
      cwd: dir,
      maxBuffer: 256 * 1024 * 1024,
      encoding: "buffer",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    });
    return stdout;
  } catch {
    return null;
  }
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

/**
 * Every blob tracked at HEAD ("/"-separated path → object id), from ONE git
 * call — compare contents against it with blobId() instead of spawning a
 * `git show` per file.
 */
export async function headBlobs(dir: string): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  for (const record of (await git(dir, "ls-tree", "-r", "-z", "HEAD")).split("\0")) {
    // "<mode> <type> <object>\t<path>"
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(record);
    if (m) blobs.set(m[2], m[1]);
  }
  return blobs;
}

/** The object id git gives `content` as a blob (SHA-1, or SHA-256 repos when `like` is one). */
export function blobId(content: Buffer, like = ""): string {
  return createHash(like.length === 64 ? "sha256" : "sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
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

