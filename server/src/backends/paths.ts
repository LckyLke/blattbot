/**
 * Hard file-access fence for the Claude backend.
 *
 * The Agent SDK's own file tools reach anywhere the OS lets the process go, so
 * "stay inside the project" was previously an instruction rather than a rule.
 * Instructions are the wrong protection here: project files, PDFs, fetched web
 * pages, and attached context are untrusted input, and an injected line telling
 * the agent to read a credential file would otherwise be obeyed. Everything
 * below is enforced in the permission callback, before a tool ever runs.
 *
 * The openai backend enforces the same boundary in its own path resolvers
 * (resolveReadPath / resolveWritePath) — this brings the two backends level.
 */
import { homedir } from "node:os";
import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.js";
import { chatUploadsDir } from "../chatimages.js";

/** Tool inputs that name a file, by tool. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "filePath"] as const;

/** Tools whose target must be inside the project (or a read-only context dir). */
const READ_TOOLS = new Set(["Read", "NotebookRead", "Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function isInside(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

/** Refuse symlinks below an allowed root, including dangling links and
 * symlinked parents of files that do not exist yet. */
export function assertNoSymlinkPath(root: string, abs: string): void {
  let current = root;
  for (const part of relative(root, abs).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("symbolic links are not allowed in agent file paths");
    } catch (e: any) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
  }
}

/**
 * Read roots BlattBot grants on top of the project and its attached context:
 * the images the USER attached to this project's chat. They live under
 * DATA_DIR (never the working tree — anything there would land in the review
 * diff and be pushed to Overleaf), so without this the agent could not open a
 * screenshot the user just sent it. Scoped to the one project's own directory;
 * another project's images stay outside every read root, and the credential
 * files listed in secretRoots() are unaffected.
 */
export function projectReadRoots(projectId: string): string[] {
  return [chatUploadsDir(projectId)];
}

/**
 * Directories that must stay unreachable no matter what: BlattBot's own data
 * (Overleaf session cookies, the local API token, chat transcripts) and the
 * usual credential stores. Listed explicitly so a project that legitimately
 * lives under $HOME is not blanket-blocked.
 */
export function secretRoots(): string[] {
  const home = homedir();
  return [
    // NOT all of DATA_DIR: the project working trees live under
    // DATA_DIR/projects/<id>, so blanket-denying it would lock the agent out
    // of the very files it is meant to edit. Only the sensitive entries.
    join(DATA_DIR, "accounts.json"),
    join(DATA_DIR, "settings.json"),
    join(DATA_DIR, "projects.json"),
    join(DATA_DIR, "auth-token"),
    join(DATA_DIR, "oai-sessions"),
    join(DATA_DIR, "chats"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".netrc"),
    join(home, ".git-credentials"),
    join(home, ".claude"),
    join(home, ".codex"),
  ];
}

/**
 * Deny rules for the SDK's `disallowedTools`. This is the layer that is
 * actually enforced under permissionMode "bypassPermissions": the CLI's
 * permission pipeline evaluates deny rules FIRST and only then applies the
 * bypass auto-allow (verified against the bundled CLI), so a rule here
 * stops the tool call, while the canUseTool fence below never sees it.
 *
 * It is a blocklist of the paths that must never be readable — credentials and
 * BlattBot's own data (Overleaf session cookies, the local API token, chat
 * transcripts) — not a project-only jail: rules cannot express "everything
 * except the project". True confinement would need an OS-level sandbox.
 */
/**
 * Every spelling of one protected root that a permission rule might need.
 * Patterns are glob-style, so separators must be forward slashes — on Windows
 * a rule built from a native path (`~\.ssh`, `C:\Users\me\.ssh`) matches
 * nothing. The native form is emitted too, in case the matcher compares
 * against raw platform paths. Pure and home-injectable so both platforms'
 * shapes can be tested from either OS.
 */
export function denyPathForms(root: string, home: string): string[] {
  const posix = (p: string) => p.replace(/\\/g, "/");
  const sameRoot = root === home || root.startsWith(home + "\\") || root.startsWith(home + "/");
  const forms = new Set<string>();
  if (sameRoot) forms.add(`~${posix(root.slice(home.length))}`);
  forms.add(posix(root));
  forms.add(root);
  return [...forms];
}

export function secretDenyRules(): string[] {
  const home = homedir();
  const rules: string[] = [];
  for (const root of secretRoots()) {
    for (const form of denyPathForms(root, home)) {
      for (const tool of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"]) {
        rules.push(`${tool}(${form}/**)`);
        rules.push(`${tool}(${form})`);
      }
    }
  }
  return rules;
}

export interface FenceResult {
  ok: boolean;
  /** Agent-facing explanation when blocked. */
  message?: string;
}

/**
 * Check one tool call against the fence. Reads are allowed inside the project
 * directory, any attached read-only context directory, and `extraReadRoots`
 * (the project's own chat-image uploads); writes are allowed only into the
 * project itself.
 */
export function checkToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  projectDir: string,
  contextDirs: string[],
  extraReadRoots: string[] = [],
): FenceResult {
  const readRoots = [projectDir, ...contextDirs, ...extraReadRoots];
  const secrets = secretRoots();

  const judge = (raw: string, write: boolean): FenceResult | null => {
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(projectDir, raw);
    // The project tree itself lives under the data directory — it is always
    // allowed, and must be tested before the protected-path check.
    if (isInside(abs, projectDir) && !isInside(abs, join(projectDir, ".git"))) {
      return null;
    }
    if (secrets.some((s) => isInside(abs, s))) {
      return {
        ok: false,
        message: `Access to ${raw} is blocked: that path holds credentials or BlattBot's own data. It is never part of the writing task — continue without it.`,
      };
    }
    if (write) {
      if (!isInside(abs, projectDir)) {
        return {
          ok: false,
          message: `Writing to ${raw} is blocked: edits must stay inside the project working tree (attached context is read-only).`,
        };
      }
      if (isInside(abs, join(projectDir, ".git"))) {
        return { ok: false, message: "The .git directory is off-limits — BlattBot owns version control." };
      }
      return null;
    }
    if (!readRoots.some((r) => isInside(abs, r))) {
      return {
        ok: false,
        message: `Reading ${raw} is blocked: it is outside the project and its attached context. Ask the user to attach that folder as context if it is genuinely needed.`,
      };
    }
    return null;
  };

  const isWrite = WRITE_TOOLS.has(toolName);
  if (isWrite || READ_TOOLS.has(toolName)) {
    for (const field of PATH_FIELDS) {
      const raw = input[field];
      if (typeof raw === "string" && raw.trim()) {
        const verdict = judge(raw.trim(), isWrite);
        if (verdict) return verdict;
      }
    }
    return { ok: true };
  }

  if (toolName === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return checkBashCommand(cmd, projectDir, [...contextDirs, ...extraReadRoots]);
  }

  return { ok: true };
}

/**
 * Bash gets a narrower rule than the file tools: shell commands cannot be
 * parsed reliably, so rather than guess at every path, block the two things
 * that actually matter — any mention of a protected directory, and paths under
 * $HOME that lie outside the project/context. System paths (/usr, /bin, …)
 * stay available so ordinary tooling keeps working.
 *
 * RELATIVE tokens are resolved against `projectDir` because that is Bash's
 * cwd. Without that step `cat ../../accounts.json` contains no path-shaped
 * token at all and walks straight out of the project — the project tree lives
 * at DATA_DIR/projects/<id>, so two levels up is BlattBot's own data
 * directory. Resolving first also means the overwhelming majority of tokens
 * (`grep`, `-rn`, `main.tex`) land inside the project and are allowed by the
 * same project/context-first rule that governs absolute ones.
 */
export function checkBashCommand(
  command: string,
  projectDir: string,
  contextDirs: string[],
): FenceResult {
  const home = homedir();
  const secrets = secretRoots();
  const readRoots = [projectDir, ...contextDirs];
  const expand = (t: string) => (t.startsWith("~/") ? join(home, t.slice(2)) : t);

  // Two passes over the same command: the path-shaped tokens (~/… or /…), and
  // every remaining word, which is judged relative to the project directory.
  // The first pass is kept separate so an embedded absolute path
  // ("$HOME/.ssh/id_rsa") is still caught at the slash.
  const absTokens = command.match(/(?:~|\/)[^\s'";|&()<>]*/g) ?? [];
  const wordTokens = command.match(/[^\s'"`;|&()<>]+/g) ?? [];
  for (const token of new Set([...absTokens, ...wordTokens])) {
    const cleaned = expand(token.replace(/["'`]/g, ""));
    if (!cleaned) continue;
    const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(projectDir, cleaned);
    if (readRoots.some((r) => isInside(abs, r))) continue; // project/context first
    if (secrets.some((s) => isInside(abs, s))) {
      return {
        ok: false,
        message: `That command touches ${token}, which holds credentials or BlattBot's own data — it is blocked. Continue without it.`,
      };
    }
    if (isInside(abs, home)) {
      return {
        ok: false,
        message: `That command reaches ${token}, outside the project and its attached context — blocked. Work inside the project directory.`,
      };
    }
  }
  return { ok: true };
}
