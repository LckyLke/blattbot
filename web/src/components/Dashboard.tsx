import { useEffect, useMemo, useState } from "react";
import { api, type Account, type OlProject, type Project } from "../api";
import AccountSignIn from "./AccountSignIn";
import { useDialog } from "./Dialog";

interface Props {
  projects: Project[];
  accounts: Account[];
  onOpen: (id: string) => void;
  onChanged: () => void;
  onOpenSettings: () => void;
}

function ago(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

/** The responsive project card grid shared by every dashboard section. */
const GRID_CLS =
  "card-grid mt-4 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3";
const CARD_CLS =
  "group relative flex flex-col rounded-lg border border-rule bg-ink-2 transition-colors hover:border-leaf/50";

type FormKind = "none" | "account" | "blank" | "git";

/**
 * The project hub: a heading row with the global actions, every Overleaf
 * account with its remote projects as a card grid (imported ones open, the
 * rest get an Import action), plus local/git projects with creation and
 * publish-to-Overleaf affordances.
 */
export default function Dashboard({ projects, accounts, onOpen, onChanged, onOpenSettings }: Props) {
  const [form, setForm] = useState<FormKind>("none");

  const accountIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  // Everything that doesn't live under a listed account: local, git, orphans.
  const localish = useMemo(
    () =>
      projects.filter(
        (p) => p.kind === "local" || p.kind === "git" || !(p.accountId && accountIds.has(p.accountId)),
      ),
    [projects, accountIds],
  );

  const empty = accounts.length === 0 && projects.length === 0;

  async function addAccount(url: string, cookie: string) {
    await api.addAccount(url, cookie);
    setForm("none");
    onChanged();
  }

  const toggleForm = (kind: FormKind) => setForm((f) => (f === kind ? "none" : kind));
  const actionCls = (kind: FormKind) =>
    `rounded border px-3 py-1.5 text-[12.5px] transition-colors ${
      form === kind
        ? "border-leaf/60 bg-leaf/10 text-paper"
        : "border-rule text-paper-dim hover:border-leaf hover:text-leaf"
    }`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-10 pb-20 pt-12">
        <div className="flex flex-wrap items-baseline gap-3">
          <img src="/logo.svg" alt="" aria-hidden="true" className="h-[30px] w-auto self-center" />
          <h2 className="font-serif text-[28px] text-paper">Projects</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button onClick={() => toggleForm("account")} className={actionCls("account")}>
              + add account
            </button>
            <button onClick={() => toggleForm("blank")} className={actionCls("blank")}>
              New blank project
            </button>
            <button onClick={() => toggleForm("git")} className={actionCls("git")}>
              Connect git repository
            </button>
            <button
              onClick={onOpenSettings}
              aria-label="Open settings"
              className="rounded border border-rule px-3 py-1.5 text-[12.5px] text-graphite transition-colors hover:border-rule hover:text-paper-dim"
            >
              ⚙ Settings
            </button>
          </div>
        </div>

        {empty && form === "none" && (
          <p className="mt-6 max-w-lg font-serif text-[15px] leading-relaxed text-graphite">
            Sign in to Overleaf and pick projects straight from your account — or start a blank
            local project. BlattBot edits a synced copy, verifies it compiles, and shows you every
            change before it reaches Overleaf.
          </p>
        )}

        {(form === "account" || (empty && form === "none")) && (
          <div className="mt-6 max-w-xl rounded-lg border border-rule bg-ink-2 p-5">
            <p className="mb-3 text-[12px] font-medium uppercase tracking-[0.14em] text-graphite">
              Add an Overleaf account
            </p>
            <AccountSignIn autoFocus={empty} onSession={addAccount} />
          </div>
        )}

        {form === "blank" && <BlankForm onDone={onChanged} onOpen={onOpen} onClose={() => setForm("none")} />}
        {form === "git" && <GitForm onDone={onChanged} onOpen={onOpen} onClose={() => setForm("none")} />}

        {accounts.map((a) => (
          <AccountSection
            key={a.id}
            account={a}
            projects={projects}
            onOpen={onOpen}
            onChanged={onChanged}
          />
        ))}

        <LocalSection
          projects={localish}
          accounts={accounts}
          onOpen={onOpen}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}

// ---- Creation forms (opened from the global actions row) -------------------

function BlankForm({
  onDone,
  onOpen,
  onClose,
}: {
  onDone: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createBlank(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const added = await api.addProject({ local: true, name: newName.trim() });
      onClose();
      onDone();
      onOpen(added.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={createBlank} className="mt-6 max-w-xl rounded-lg border border-rule bg-ink-2 p-5">
      <label className="block text-[12px] text-graphite">
        Project name
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="My new paper"
          className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 text-[13px] text-paper placeholder:text-graphite/60"
        />
      </label>
      <p className="mt-2 text-[12px] leading-snug text-graphite">
        Starts with a minimal main.tex and an empty bibliography. You can publish it to an
        Overleaf account later.
      </p>
      {error && <p className="mt-2 text-[12px] leading-snug text-pencil">{error}</p>}
      <div className="mt-3 flex justify-end">
        <button
          disabled={pending || !newName.trim()}
          className="rounded bg-leaf-deep px-4 py-1.5 text-[13px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}

function GitForm({
  onDone,
  onOpen,
  onClose,
}: {
  onDone: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [gitUrl, setGitUrl] = useState("");
  const [gitToken, setGitToken] = useState("");
  const [gitName, setGitName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connectGit(e: React.FormEvent) {
    e.preventDefault();
    if (!gitUrl.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const added = await api.addProject({
        url: gitUrl.trim(),
        token: gitToken.trim() || undefined,
        name: gitName.trim() || undefined,
      });
      onClose();
      onDone();
      onOpen(added.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={connectGit} className="mt-6 max-w-xl rounded-lg border border-rule bg-ink-2 p-5">
      <label className="block text-[12px] text-graphite">
        Git URL
        <input
          autoFocus
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
          placeholder="https://git.overleaf.com/… or any git remote"
          className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-[13px] text-paper placeholder:text-graphite/60"
        />
      </label>
      <label className="mt-3 block text-[12px] text-graphite">
        Git token <span className="text-graphite/60">(if the remote needs one)</span>
        <input
          value={gitToken}
          onChange={(e) => setGitToken(e.target.value)}
          type="password"
          placeholder="olp_…"
          className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-[13px] text-paper placeholder:text-graphite/60"
        />
      </label>
      <label className="mt-3 block text-[12px] text-graphite">
        Name <span className="text-graphite/60">(optional)</span>
        <input
          value={gitName}
          onChange={(e) => setGitName(e.target.value)}
          placeholder="My thesis"
          className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 text-[13px] text-paper placeholder:text-graphite/60"
        />
      </label>
      {error && <p className="mt-2 text-[12px] leading-snug text-pencil">{error}</p>}
      <div className="mt-3 flex justify-end">
        <button
          disabled={pending || !gitUrl.trim()}
          className="rounded bg-leaf-deep px-4 py-1.5 text-[13px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
        >
          {pending ? "Cloning…" : "Connect project"}
        </button>
      </div>
    </form>
  );
}

// ---- Overleaf account section ---------------------------------------------

function AccountSection({
  account,
  projects,
  onOpen,
  onChanged,
}: {
  account: Account;
  projects: Project[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [list, setList] = useState<OlProject[] | null>(null);
  const [listing, setListing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<"import" | "browser" | null>(null);
  const [refresh, setRefresh] = useState(0);

  const imported = useMemo(
    () =>
      new Map(
        projects
          .filter((p) => p.accountId === account.id && p.overleafProjectId)
          .map((p) => [p.overleafProjectId!, p]),
      ),
    [projects, account.id],
  );

  useEffect(() => {
    let stale = false;
    setListing(true);
    setError(null);
    setExpired(false);
    api
      .accountProjects(account.id)
      .then((res) => {
        if (stale) return;
        setList(
          [...res.projects].sort(
            (a, b) => Date.parse(b.lastUpdated ?? "0") - Date.parse(a.lastUpdated ?? "0"),
          ),
        );
      })
      .catch((err) => {
        if (stale) return;
        setError(err.message);
        if (/expired|reconnect/i.test(err.message)) setExpired(true);
      })
      .finally(() => !stale && setListing(false));
    return () => {
      stale = true;
    };
  }, [account.id, refresh]);

  const disconnected = account.status === "disconnected" || expired;

  async function reconnect(mode: "import" | "browser") {
    setReconnecting(mode);
    setError(null);
    try {
      await api.refreshAccount(account.id, mode);
      onChanged();
      setRefresh((r) => r + 1);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setReconnecting(null);
    }
  }

  async function importProject(p: OlProject) {
    setImporting(p.id);
    setError(null);
    try {
      await api.addProject({ accountId: account.id, projectId: p.id, name: p.name });
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setImporting(null);
    }
  }

  async function removeProject(p: Project) {
    const ok = await dialog.confirm({
      title: "Remove this project?",
      body: `BlattBot forgets its synced copy of “${p.name}” — the Overleaf project itself is untouched.`,
      confirmLabel: "Remove project",
      danger: true,
    });
    if (!ok) return;
    await api.deleteProject(p.id).catch(() => {});
    onChanged();
  }

  const visible = (list ?? []).filter((p) => showHidden || (!p.archived && !p.trashed));
  const hiddenCount = (list ?? []).filter((p) => p.archived || p.trashed).length;
  // Imported projects the remote listing doesn't know (yet) — e.g. just published.
  const leftover = [...imported.values()].filter(
    (p) => !(list ?? []).some((r) => r.id === p.overleafProjectId),
  );
  const projectCount = list === null ? null : list.length + leftover.length;

  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          title={disconnected ? "Session expired" : "Connected"}
          className={`inline-block h-2 w-2 self-center rounded-full ${disconnected ? "bg-pencil" : "bg-leaf"}`}
        />
        <h3 className="font-serif text-[18px] text-paper">{account.host}</h3>
        <span className="font-mono text-[12px] text-graphite">
          {account.email}
          {account.email && projectCount !== null && " · "}
          {projectCount !== null && `${projectCount} project${projectCount === 1 ? "" : "s"}`}
        </span>
        {disconnected && (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-pencil">session expired —</span>
            <button
              onClick={() => reconnect("import")}
              disabled={reconnecting !== null}
              className="rounded border border-rule px-2.5 py-0.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
            >
              {reconnecting === "import" ? "Looking for a session…" : "Reconnect from browser session"}
            </button>
            <button
              onClick={() => reconnect("browser")}
              disabled={reconnecting !== null}
              className="rounded border border-rule px-2.5 py-0.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
            >
              {reconnecting === "browser" ? "Waiting for login…" : "Log in via browser"}
            </button>
          </span>
        )}
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowHidden((s) => !s)}
            className="ml-auto text-[12px] text-graphite underline decoration-rule underline-offset-2 hover:text-paper-dim"
          >
            {showHidden ? "hide" : "show"} {hiddenCount} archived
          </button>
        )}
      </div>

      {error && (!disconnected || !/expired|reconnect/i.test(error)) && (
        <p className="mt-2 text-[12px] leading-snug text-pencil">{error}</p>
      )}
      {listing && (
        <p className="mt-3 flex items-center gap-2 text-[12px] text-gold">
          <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-gold" />
          Fetching projects…
        </p>
      )}

      {(visible.length > 0 || leftover.length > 0) && (
        <ul className={GRID_CLS}>
          {visible.map((p) => {
            const local = imported.get(p.id);
            return (
              <li key={p.id} className={CARD_CLS}>
                {local ? (
                  <>
                    <button
                      onClick={() => onOpen(local.id)}
                      aria-label={`Open ${p.name}`}
                      className="flex w-full flex-1 flex-col items-start p-4 text-left"
                    >
                      <span className="pr-5 font-serif text-[16px] leading-snug text-paper">
                        {p.name}
                      </span>
                      <span className="mt-auto flex w-full items-center gap-1.5 pt-3">
                        <span className="rounded-sm border border-leaf/40 px-1 font-mono text-[10.5px] uppercase tracking-wide text-leaf">
                          connected
                        </span>
                        {p.archived && <ArchivedBadge />}
                        <span className="ml-auto font-mono text-[11px] text-graphite">
                          {ago(p.lastUpdated) ?? ""}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={() => removeProject(local)}
                      aria-label={`Remove ${p.name}`}
                      className="absolute right-2 top-2 hidden rounded px-1.5 text-sm text-graphite hover:text-pencil group-hover:block"
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <div className="flex w-full flex-1 flex-col items-start p-4">
                    <span className="font-serif text-[16px] leading-snug text-paper-dim">
                      {p.name}
                    </span>
                    <span className="mt-auto flex w-full items-center gap-1.5 pt-3">
                      {p.archived && <ArchivedBadge />}
                      <span className="font-mono text-[11px] text-graphite">
                        {ago(p.lastUpdated) ?? ""}
                      </span>
                      <button
                        onClick={() => importProject(p)}
                        disabled={importing !== null}
                        aria-label={`Import ${p.name}`}
                        className="ml-auto rounded border border-rule px-2.5 py-0.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                      >
                        {importing === p.id ? "Importing…" : "Import"}
                      </button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
          {leftover.map((p) => (
            <li key={p.id} className={CARD_CLS}>
              <button
                onClick={() => onOpen(p.id)}
                aria-label={`Open ${p.name}`}
                className="flex w-full flex-1 flex-col items-start p-4 text-left"
              >
                <span className="pr-5 font-serif text-[16px] leading-snug text-paper">{p.name}</span>
                <span className="mt-auto flex w-full items-center gap-1.5 pt-3">
                  <span className="rounded-sm border border-leaf/40 px-1 font-mono text-[10.5px] uppercase tracking-wide text-leaf">
                    connected
                  </span>
                </span>
              </button>
              <button
                onClick={() => removeProject(p)}
                aria-label={`Remove ${p.name}`}
                className="absolute right-2 top-2 hidden rounded px-1.5 text-sm text-graphite hover:text-pencil group-hover:block"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {!listing && !error && visible.length === 0 && leftover.length === 0 && (
        <p className="mt-3 text-[12.5px] text-graphite">No projects in this account.</p>
      )}
    </section>
  );
}

function ArchivedBadge() {
  return (
    <span className="rounded-sm border border-rule px-1 font-mono text-[10.5px] uppercase tracking-wide text-graphite">
      archived
    </span>
  );
}

// ---- Local & git section ---------------------------------------------------

function LocalSection({
  projects,
  accounts,
  onOpen,
  onChanged,
}: {
  projects: Project[];
  accounts: Account[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  // Publish-to-Overleaf state (one project at a time).
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pickedAccount, setPickedAccount] = useState<string>("");
  const [publishing, setPublishing] = useState<string | null>(null);
  const [pubError, setPubError] = useState<{ id: string; message: string } | null>(null);
  const [pubDone, setPubDone] = useState<{ id: string; host: string } | null>(null);

  async function publish(project: Project, accountId: string) {
    setPublishing(project.id);
    setPubError(null);
    setPubDone(null);
    setPickerFor(null);
    try {
      await api.publishProject(project.id, accountId);
      const host = accounts.find((a) => a.id === accountId)?.host ?? "Overleaf";
      setPubDone({ id: project.id, host });
      onChanged();
    } catch (err: any) {
      setPubError({ id: project.id, message: err.message });
    } finally {
      setPublishing(null);
    }
  }

  function startPublish(project: Project) {
    setPubError(null);
    setPubDone(null);
    if (accounts.length === 1) {
      void publish(project, accounts[0].id);
    } else {
      setPickedAccount(accounts[0]?.id ?? "");
      setPickerFor((cur) => (cur === project.id ? null : project.id));
    }
  }

  async function removeProject(p: Project) {
    const ok = await dialog.confirm({
      title: "Remove this project?",
      body: `The local files and history of “${p.name}” are deleted. This cannot be undone.`,
      confirmLabel: "Remove project",
      danger: true,
    });
    if (!ok) return;
    await api.deleteProject(p.id).catch(() => {});
    onChanged();
  }

  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-3">
        <span className="inline-block h-2 w-2 self-center rounded-full bg-gold/70" />
        <h3 className="font-serif text-[18px] text-paper">Local &amp; git</h3>
        <span className="font-mono text-[12px] text-graphite">
          {projects.length} project{projects.length === 1 ? "" : "s"}
        </span>
      </div>

      {projects.length > 0 ? (
        <ul className={GRID_CLS}>
          {projects.map((p) => (
            <li key={p.id} className={CARD_CLS}>
              <button
                onClick={() => onOpen(p.id)}
                aria-label={`Open ${p.name}`}
                className="flex w-full flex-1 flex-col items-start p-4 pb-2.5 text-left"
              >
                <span className="pr-5 font-serif text-[16px] leading-snug text-paper">{p.name}</span>
                <span className="mt-auto flex w-full items-center gap-1.5 pt-3">
                  <span
                    className={`rounded-sm border px-1 font-mono text-[10.5px] uppercase tracking-wide ${
                      p.kind === "local" ? "border-gold/40 text-gold" : "border-rule text-graphite"
                    }`}
                  >
                    {p.kind === "local" ? "local" : p.kind === "git" ? "git" : "overleaf"}
                  </span>
                  <span className="ml-auto truncate font-mono text-[11px] text-graphite">
                    {p.mainTex ?? ""}
                  </span>
                </span>
              </button>
              <button
                onClick={() => removeProject(p)}
                aria-label={`Remove ${p.name}`}
                className="absolute right-2 top-2 hidden rounded px-1.5 text-sm text-graphite hover:text-pencil group-hover:block"
              >
                ×
              </button>
              {p.kind === "local" && (
                <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
                  <button
                    onClick={() => startPublish(p)}
                    disabled={publishing !== null || accounts.length === 0}
                    aria-label={`Publish ${p.name} to Overleaf`}
                    title={accounts.length === 0 ? "Add an Overleaf account first" : undefined}
                    className="rounded border border-rule px-2.5 py-0.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                  >
                    {publishing === p.id ? "Publishing…" : "Publish to Overleaf"}
                  </button>
                  {publishing === p.id && (
                    <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-gold" />
                  )}
                  {pickerFor === p.id && accounts.length > 1 && (
                    <>
                      <select
                        value={pickedAccount}
                        onChange={(e) => setPickedAccount(e.target.value)}
                        aria-label="Publish account"
                        className="rounded border border-rule bg-ink px-1.5 py-0.5 text-[12px] text-paper"
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.host}
                            {a.email ? ` · ${a.email}` : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => void publish(p, pickedAccount)}
                        disabled={!pickedAccount}
                        className="rounded bg-leaf-deep px-2.5 py-0.5 text-[12px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
                      >
                        Publish
                      </button>
                    </>
                  )}
                  {pubError?.id === p.id && (
                    <span className="truncate text-[12px] text-pencil">{pubError.message}</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[12.5px] text-graphite">No local or git projects yet.</p>
      )}
      {/* Published rows move up into their account's section, so report here. */}
      {pubDone && (
        <p className="mt-3 text-[12px] text-leaf">
          Published to {pubDone.host} — the project now syncs with that account.
        </p>
      )}
    </section>
  );
}
