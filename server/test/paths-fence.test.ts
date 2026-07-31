import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The file-access fence. Two layers, and the distinction matters:
 *  - secretDenyRules() feed the SDK's disallowedTools, which the CLI evaluates
 *    BEFORE the bypassPermissions auto-allow — that layer actually bites.
 *  - checkToolPaths() is the canUseTool fence: defence in depth for any tool
 *    call that reaches the callback.
 */

let dataDir: string;
let projectDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-fence-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "blattbot-fence-proj-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const load = () => import("../src/backends/paths.js");

describe("deny rules (the layer enforced under bypassPermissions)", () => {
  it("covers BlattBot's credential files — they hold Overleaf cookies and the API token", async () => {
    const { secretDenyRules } = await load();
    const rules = secretDenyRules();
    for (const secret of ["accounts.json", "auth-token", "settings.json"]) {
      expect(rules.some((r) => r.startsWith("Read(") && r.includes(join(dataDir, secret)))).toBe(true);
    }
  });

  it("NEVER denies the project working trees, which live under the same data dir", async () => {
    const { secretDenyRules } = await load();
    // Regression: denying DATA_DIR wholesale locked the agent out of the very
    // files it edits ("File is in a directory that is denied by your
    // permission settings" on every read).
    const projects = join(dataDir, "projects");
    for (const rule of secretDenyRules()) {
      const target = rule.slice(rule.indexOf("(") + 1, -1).replace(/\/\*\*$/, "");
      expect(projects.startsWith(target) && target !== "").toBe(false);
    }
  });

  it("covers the usual credential stores for every file tool", async () => {
    const { secretDenyRules } = await load();
    const rules = secretDenyRules();
    for (const tool of ["Read", "Edit", "Write", "Glob", "Grep"]) {
      expect(rules.some((r) => r.startsWith(`${tool}(`) && r.includes(".ssh"))).toBe(true);
    }
    expect(rules.some((r) => r.includes(".aws"))).toBe(true);
    expect(rules.some((r) => r.includes(".gnupg"))).toBe(true);
  });

  it("emits ~-relative and absolute spellings so either match form is caught", async () => {
    const { secretDenyRules } = await load();
    const ssh = secretDenyRules().filter((r) => r.startsWith("Read(") && r.includes(".ssh"));
    // The ~ form is always glob-style (forward slashes) whatever the platform.
    expect(ssh.some((r) => r.includes("~/"))).toBe(true);
    expect(ssh.some((r) => r.includes(homedir()))).toBe(true);
  });

  it("builds Windows rules with glob separators — backslash patterns match nothing", async () => {
    const { denyPathForms } = await load();
    // Exercised from any OS: a native Windows path must still yield ~/-style
    // and forward-slash absolute patterns (this failed only on Windows CI).
    const forms = denyPathForms("C:\\Users\\me\\.ssh", "C:\\Users\\me");
    expect(forms).toContain("~/.ssh");
    expect(forms).toContain("C:/Users/me/.ssh");
    // The native spelling is kept as well, for a matcher comparing raw paths.
    expect(forms).toContain("C:\\Users\\me\\.ssh");
  });

  it("builds POSIX rules unchanged, without duplicate spellings", async () => {
    const { denyPathForms } = await load();
    const forms = denyPathForms("/home/me/.ssh", "/home/me");
    expect(forms).toEqual(["~/.ssh", "/home/me/.ssh"]);
  });

  it("omits the ~ form for a root outside the home directory", async () => {
    const { denyPathForms } = await load();
    expect(denyPathForms("/var/lib/blattbot/accounts.json", "/home/me")).toEqual([
      "/var/lib/blattbot/accounts.json",
    ]);
  });
});

describe("canUseTool fence", () => {
  it("allows reads and writes inside the project", async () => {
    const { checkToolPaths } = await load();
    expect(checkToolPaths("Read", { file_path: "main.tex" }, projectDir, []).ok).toBe(true);
    expect(checkToolPaths("Read", { file_path: join(projectDir, "sections/x.tex") }, projectDir, []).ok).toBe(true);
    expect(checkToolPaths("Write", { file_path: "new.tex" }, projectDir, []).ok).toBe(true);
  });

  it("blocks reads outside the project and its attached context", async () => {
    const { checkToolPaths } = await load();
    const r = checkToolPaths("Read", { file_path: "/etc/passwd" }, projectDir, []);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/outside the project/);
  });

  it("allows reads from an attached context directory but never writes there", async () => {
    const { checkToolPaths } = await load();
    const ctx = mkdtempSync(join(tmpdir(), "blattbot-fence-ctx-"));
    try {
      expect(checkToolPaths("Read", { file_path: join(ctx, "paper.pdf") }, projectDir, [ctx]).ok).toBe(true);
      const w = checkToolPaths("Write", { file_path: join(ctx, "paper.pdf") }, projectDir, [ctx]);
      expect(w.ok).toBe(false);
      expect(w.message).toMatch(/inside the project working tree/);
    } finally {
      rmSync(ctx, { recursive: true, force: true });
    }
  });

  it("allows the project tree even though it sits inside the data directory", async () => {
    const { checkToolPaths } = await load();
    const proj = join(dataDir, "projects", "p1");
    expect(checkToolPaths("Read", { file_path: join(proj, "content.tex") }, proj, []).ok).toBe(true);
    expect(checkToolPaths("Read", { file_path: "content.tex" }, proj, []).ok).toBe(true);
    expect(checkToolPaths("Write", { file_path: join(proj, "new.tex") }, proj, []).ok).toBe(true);
    expect(checkToolPaths("Bash", { command: `grep -rn x ${proj}` }, proj, []).ok).toBe(true);
  });

  it("grants the project's own chat-image uploads — the feature is dead without it", async () => {
    const { checkToolPaths, projectReadRoots } = await load();
    const { chatUploadsDir } = await import("../src/chatimages.js");
    const roots = projectReadRoots("proj-a");
    expect(roots).toEqual([chatUploadsDir("proj-a")]);
    const image = join(chatUploadsDir("proj-a"), "6f1a3c2e-1111-4222-8333-444455556666.png");
    expect(checkToolPaths("Read", { file_path: image }, projectDir, [], roots).ok).toBe(true);
    expect(checkToolPaths("Bash", { command: `file ${image}` }, projectDir, [], roots).ok).toBe(true);
    // …read-only: the uploads are not part of the working tree.
    const w = checkToolPaths("Write", { file_path: image }, projectDir, [], roots);
    expect(w.ok).toBe(false);
    expect(w.message).toMatch(/inside the project working tree/);
  });

  it("scopes the grant to ONE project — another project's images stay blocked", async () => {
    const { checkToolPaths, projectReadRoots } = await load();
    const { chatUploadsDir } = await import("../src/chatimages.js");
    const other = join(chatUploadsDir("proj-b"), "6f1a3c2e-1111-4222-8333-444455556666.png");
    const r = checkToolPaths("Read", { file_path: other }, projectDir, [], projectReadRoots("proj-a"));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/outside the project/);
  });

  it("still blocks accounts.json while chat-uploads are granted", async () => {
    const { checkToolPaths, projectReadRoots } = await load();
    const roots = projectReadRoots("proj-a");
    for (const secret of ["accounts.json", "auth-token", "settings.json", "projects.json"]) {
      const r = checkToolPaths("Read", { file_path: join(dataDir, secret) }, projectDir, [], roots);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/credentials or BlattBot's own data/);
    }
    // Chat transcripts too — sibling of chat-uploads, and off-limits.
    expect(
      checkToolPaths("Read", { file_path: join(dataDir, "chats", "p", "c.jsonl") }, projectDir, [], roots).ok,
    ).toBe(false);
  });

  it("blocks credential paths and BlattBot's own state outright", async () => {
    const { checkToolPaths } = await load();
    for (const p of [join(homedir(), ".ssh/id_rsa"), join(dataDir, "accounts.json")]) {
      const r = checkToolPaths("Read", { file_path: p }, projectDir, []);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/credentials or BlattBot's own data/);
    }
  });

  it("blocks traversal out of the project via a relative path", async () => {
    const { checkToolPaths } = await load();
    expect(checkToolPaths("Read", { file_path: "../../../etc/passwd" }, projectDir, []).ok).toBe(false);
    expect(checkToolPaths("Write", { file_path: "../escape.tex" }, projectDir, []).ok).toBe(false);
  });

  it("keeps .git off-limits — BlattBot owns version control", async () => {
    const { checkToolPaths } = await load();
    const r = checkToolPaths("Write", { file_path: ".git/config" }, projectDir, []);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/\.git directory is off-limits/);
  });

  it("leaves non-file tools alone", async () => {
    const { checkToolPaths } = await load();
    expect(checkToolPaths("WebSearch", { query: "latex" }, projectDir, []).ok).toBe(true);
    expect(checkToolPaths("mcp__blattbot__compile_latex", {}, projectDir, []).ok).toBe(true);
  });
});

describe("bash command fence", () => {
  it("blocks commands that reach into credential stores", async () => {
    const { checkBashCommand } = await load();
    const r = checkBashCommand("cat ~/.ssh/id_rsa", projectDir, []);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/credentials or BlattBot's own data/);
  });

  it("blocks commands that read BlattBot's account store", async () => {
    const { checkBashCommand } = await load();
    expect(checkBashCommand(`cat ${dataDir}/accounts.json`, projectDir, []).ok).toBe(false);
  });

  it("blocks other home-directory paths outside the project", async () => {
    const { checkBashCommand } = await load();
    const r = checkBashCommand(`cat ${join(homedir(), "Documents/taxes.txt")}`, projectDir, []);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/outside the project/);
  });

  it("leaves ordinary in-project and system commands working", async () => {
    const { checkBashCommand } = await load();
    expect(checkBashCommand("grep -rn 'section' .", projectDir, []).ok).toBe(true);
    expect(checkBashCommand("ls sections/", projectDir, []).ok).toBe(true);
    expect(checkBashCommand("/usr/bin/wc -l main.tex", projectDir, []).ok).toBe(true);
    expect(checkBashCommand(`cat ${join(projectDir, "main.tex")}`, projectDir, []).ok).toBe(true);
    expect(checkBashCommand("latexmk -pdf -interaction=nonstopmode main.tex", projectDir, []).ok).toBe(true);
    expect(checkBashCommand('find . -name "*.tex" -newer main.tex', projectDir, []).ok).toBe(true);
    expect(checkBashCommand("sed -n '1,20p' sections/intro.tex", projectDir, []).ok).toBe(true);
  });

  /**
   * The fence used to inspect only tokens starting with ~ or / — a relative
   * path was never resolved and never judged. Bash's cwd is the project
   * directory, which lives at DATA_DIR/projects/<id>, so two levels up is
   * BlattBot's own data directory: `cat ../../accounts.json` walked straight
   * to the Overleaf session cookies while the absolute spelling was refused.
   */
  describe("relative paths (they escape just as well as absolute ones)", () => {
    let proj: string;
    beforeEach(() => {
      proj = join(dataDir, "projects", "p1");
    });

    it("blocks ../../accounts.json — the exact traversal the fence used to miss", async () => {
      const { checkBashCommand } = await load();
      const r = checkBashCommand("cat ../../accounts.json", proj, []);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/credentials or BlattBot's own data/);
      // The absolute spelling of the same file has always been blocked; the
      // two must now agree.
      expect(checkBashCommand(`cat ${join(dataDir, "accounts.json")}`, proj, []).ok).toBe(false);
    });

    it("blocks ./../../auth-token — a leading ./ is not a disguise", async () => {
      const { checkBashCommand } = await load();
      const r = checkBashCommand("cp ./../../auth-token /tmp/x", proj, []);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/credentials or BlattBot's own data/);
    });

    it("blocks the other protected entries reached relatively", async () => {
      const { checkBashCommand } = await load();
      for (const cmd of [
        "cat ../../projects.json",
        "cat ../../settings.json",
        "ls ../../chats",
        "grep -r token ../../oai-sessions",
      ]) {
        expect(checkBashCommand(cmd, proj, []).ok).toBe(false);
      }
    });

    it("keeps benign relative paths allowed — the fence must not break tooling", async () => {
      const { checkBashCommand } = await load();
      for (const cmd of [
        "cat sections/intro.tex",
        "cat ./main.tex",
        "wc -l ./sections/../main.tex",
        "grep -rn 'label' . --include=*.tex",
        "mkdir -p figures/generated",
      ]) {
        expect(checkBashCommand(cmd, proj, []).ok).toBe(true);
      }
    });

    it("still allows a relative path into an attached context directory", async () => {
      const { checkBashCommand } = await load();
      const ctx = join(dataDir, "context", "lib");
      // ../../context/lib/notes.md resolves into the granted read root.
      expect(checkBashCommand("cat ../../context/lib/notes.md", proj, [ctx]).ok).toBe(true);
      // …and the project/context-first ordering still wins over the home rule.
      expect(checkBashCommand(`cat ${join(ctx, "notes.md")}`, proj, [ctx]).ok).toBe(true);
    });

    it("reaches the project's own chat uploads relatively, as the file tools do", async () => {
      const { checkBashCommand, projectReadRoots } = await load();
      expect(checkBashCommand("file ../../chat-uploads/p1/x.png", proj, projectReadRoots("p1")).ok).toBe(true);
    });

    it("blocks a relative climb into $HOME's credential stores", async () => {
      const { checkBashCommand } = await load();
      // A project directory that really lives under $HOME: the climb lands in
      // the home tree, which is off-limits outside the project itself.
      const underHome = join(homedir(), "papers", "thesis");
      const r = checkBashCommand("cat ../../.ssh/id_rsa", underHome, []);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/credentials or BlattBot's own data/);
    });
  });
});
