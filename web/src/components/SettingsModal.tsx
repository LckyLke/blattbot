import { useEffect, useState } from "react";
import { api, type Account, type AgentInfo, type Settings } from "../api";
import AccountSignIn from "./AccountSignIn";
import { useDialog } from "./Dialog";

interface Props {
  onClose: () => void;
  /** Called whenever accounts changed, so the app can refresh its lists. */
  onAccountsChanged: () => void;
}

type Tab = "accounts" | "agent" | "transparency";

const MODEL_SUGGESTIONS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "sonnet",
  "opus",
  "fable",
  "haiku",
];

export default function SettingsModal({ onClose, onAccountsChanged }: Props) {
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AgentInfo | null>(null);

  // Agent form state
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [s2Key, setS2Key] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [promptAppend, setPromptAppend] = useState("");
  const [engine, setEngine] = useState<Settings["engine"]>("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [addingAccount, setAddingAccount] = useState(false);
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  const [accountMsg, setAccountMsg] = useState<string | null>(null);

  const refreshAccounts = () =>
    api.accounts().then(setAccounts).catch(() => setAccounts([]));

  useEffect(() => {
    void refreshAccounts();
    api.settings().then((s) => {
      setSettings(s);
      setModel(s.model);
      setBaseUrl(s.anthropicBaseUrl);
      setPromptAppend(s.systemPromptAppend);
      setEngine(s.engine);
    });
    api.agentInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const patch: any = {
        model: model.trim(),
        anthropicBaseUrl: baseUrl.trim(),
        systemPromptAppend: promptAppend,
        engine,
      };
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      else if (clearKey) patch.apiKey = "";
      if (s2Key.trim()) patch.s2ApiKey = s2Key.trim();
      const next = await api.saveSettings(patch);
      setSettings(next);
      setApiKey("");
      setS2Key("");
      setClearKey(false);
      setSavedMsg("Saved.");
      api.agentInfo().then(setInfo).catch(() => {});
      setTimeout(() => setSavedMsg(null), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function addAccount(url: string, cookie: string) {
    await api.addAccount(url, cookie);
    setAddingAccount(false);
    setAccountMsg("Account connected.");
    setTimeout(() => setAccountMsg(null), 2500);
    await refreshAccounts();
    onAccountsChanged();
  }

  async function reconnect(a: Account, mode: "import" | "browser") {
    setAccountBusy(a.id);
    setAccountMsg(mode === "browser" ? "A browser window opened — log in there." : null);
    setError(null);
    try {
      await api.refreshAccount(a.id, mode);
      setAccountMsg(`Session for ${a.host} refreshed.`);
      setTimeout(() => setAccountMsg(null), 2500);
      await refreshAccounts();
      onAccountsChanged();
    } catch (err: any) {
      setAccountMsg(null);
      setError(err.message);
    } finally {
      setAccountBusy(null);
    }
  }

  async function removeAccount(a: Account) {
    const ok = await dialog.confirm({
      title: "Remove this account?",
      body: `${a.host}${a.email ? ` (${a.email})` : ""} is disconnected from BlattBot.`,
      confirmLabel: "Remove account",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api.deleteAccount(a.id);
      await refreshAccounts();
      onAccountsChanged();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Settings"
        className="flex max-h-[88vh] w-[720px] max-w-full flex-col rounded-lg border border-rule bg-ink-2 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
      >
        <header className="booktabs flex items-center gap-4 px-5 pb-3 pt-4">
          <h2 className="font-serif text-[17px] font-semibold text-paper">Settings</h2>
          <nav className="flex gap-1">
            {(
              [
                ["accounts", "Accounts"],
                ["agent", "Agent"],
                ["transparency", "Transparency"],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`rounded px-2.5 py-1 text-[12.5px] transition-colors ${
                  tab === key ? "bg-ink-3 text-paper" : "text-graphite hover:text-paper-dim"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="ml-auto rounded px-1.5 text-lg leading-none text-graphite transition-colors hover:text-paper"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 text-[12px] leading-snug text-pencil">{error}</p>}
          {accountMsg && <p className="mb-3 text-[12px] leading-snug text-leaf">{accountMsg}</p>}

          {tab === "accounts" && (
            <div>
              <p className="mb-3 font-serif text-[13px] leading-relaxed text-graphite">
                Each account is a signed-in Overleaf instance — overleaf.com and self-hosted servers
                side by side. Sessions are stored locally, survive restarts, and refresh themselves
                from your browser when they expire; an expired account shows as disconnected until
                you reconnect it.
              </p>
              <ul>
                {accounts.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-3 border-b border-rule/50 py-2.5 last:border-0"
                  >
                    <span
                      title={a.status}
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                        a.status === "connected" ? "bg-leaf" : "bg-pencil"
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-serif text-[14px] text-paper">{a.host}</span>
                      <span className="block truncate font-mono text-[10.5px] text-graphite">
                        {a.email ?? "email unknown"} · {a.projectCount} project
                        {a.projectCount === 1 ? "" : "s"}
                        {a.status === "disconnected" && (
                          <span className="text-pencil"> · disconnected</span>
                        )}
                      </span>
                    </span>
                    <span className="ml-auto flex shrink-0 gap-1.5">
                      <button
                        disabled={accountBusy !== null}
                        onClick={() => reconnect(a, "import")}
                        title="Refresh the session from your browser's cookies"
                        className="rounded border border-rule px-2 py-1 text-[11px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                      >
                        {accountBusy === a.id ? "…" : "Reconnect"}
                      </button>
                      <button
                        disabled={accountBusy !== null}
                        onClick={() => reconnect(a, "browser")}
                        title="Open a browser window to log in again"
                        className="rounded border border-rule px-2 py-1 text-[11px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                      >
                        Log in
                      </button>
                      <button
                        onClick={() => removeAccount(a)}
                        className="rounded border border-rule px-2 py-1 text-[11px] text-graphite transition-colors hover:border-pencil hover:text-pencil"
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
                {accounts.length === 0 && (
                  <li className="py-4 text-center font-serif text-sm text-graphite">
                    No accounts yet.
                  </li>
                )}
              </ul>
              {addingAccount ? (
                <div className="mt-4 rounded-md border border-rule bg-ink p-3">
                  <AccountSignIn autoFocus onSession={addAccount} />
                </div>
              ) : (
                <button
                  onClick={() => setAddingAccount(true)}
                  className="mt-4 rounded border border-rule px-3 py-1.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
                >
                  + Add account
                </button>
              )}
            </div>
          )}

          {tab === "agent" && settings && (
            <div className="max-w-[520px]">
              <p className="mb-4 font-serif text-[13px] leading-relaxed text-graphite">
                {info?.backendDescription ??
                  "The agent runs locally via the Claude Agent SDK and reuses your Claude Code login."}
              </p>

              <label className="block text-[11px] text-graphite">
                Model{" "}
                <span className="text-graphite/60">
                  (empty = claude-sonnet-5; aliases sonnet/opus/fable/haiku map to the newest of each tier)
                </span>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list="blattbot-models"
                  placeholder="claude-sonnet-5"
                  className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                />
                <datalist id="blattbot-models">
                  {MODEL_SUGGESTIONS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>

              <label className="mt-3 block text-[11px] text-graphite">
                API key{" "}
                <span className="text-graphite/60">
                  {settings.hasApiKey
                    ? "(a key is set — it never leaves this machine)"
                    : "(empty = your local Claude Code login is used)"}
                </span>
                <span className="mt-1 flex gap-1.5">
                  <input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    type="password"
                    placeholder={settings.hasApiKey ? "•••••••• (set)" : "sk-ant-…"}
                    className="min-w-0 flex-1 rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                  />
                  {settings.hasApiKey && (
                    <button
                      type="button"
                      onClick={() => {
                        setClearKey(true);
                        setApiKey("");
                      }}
                      className={`rounded border px-2.5 text-[11px] transition-colors ${
                        clearKey
                          ? "border-pencil text-pencil"
                          : "border-rule text-graphite hover:border-pencil hover:text-pencil"
                      }`}
                    >
                      {clearKey ? "will clear" : "clear"}
                    </button>
                  )}
                </span>
              </label>

              <label className="mt-3 block text-[11px] text-graphite">
                API base URL{" "}
                <span className="text-graphite/60">(for Anthropic-compatible proxies, e.g. LiteLLM)</span>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.anthropic.com"
                  className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                />
              </label>

              <label className="mt-3 block text-[11px] text-graphite">
                Extra instructions <span className="text-graphite/60">(appended to the system prompt)</span>
                <textarea
                  value={promptAppend}
                  onChange={(e) => setPromptAppend(e.target.value)}
                  rows={4}
                  placeholder="e.g. Always write in British English. Prefer \\autoref over \\ref."
                  className="mt-1 w-full resize-y rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs leading-relaxed text-paper placeholder:text-graphite/60"
                />
              </label>

              <label className="mt-3 block text-[11px] text-graphite">
                Semantic Scholar API key{" "}
                <span className="text-graphite/60">
                  {settings.hasS2ApiKey
                    ? "(set — lifts the paper-search rate limit)"
                    : "(optional — the free shared pool is heavily rate-limited)"}
                </span>
                <input
                  value={s2Key}
                  onChange={(e) => setS2Key(e.target.value)}
                  type="password"
                  placeholder={settings.hasS2ApiKey ? "•••••••• (set)" : "get one free at semanticscholar.org/product/api"}
                  className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                />
              </label>

              <label className="mt-3 block text-[11px] text-graphite">
                TeX engine
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as Settings["engine"])}
                  className="mt-1 block rounded border border-rule bg-ink px-2.5 py-2 text-xs text-paper"
                >
                  <option value="">auto (tectonic → latexmk → pdflatex)</option>
                  <option value="tectonic">tectonic</option>
                  <option value="latexmk">latexmk</option>
                  <option value="pdflatex">pdflatex</option>
                </select>
              </label>

              <div className="mt-4 flex items-center gap-3">
                {savedMsg && <span className="text-[12px] text-leaf">{savedMsg}</span>}
                <button
                  onClick={save}
                  disabled={saving}
                  className="ml-auto rounded bg-leaf-deep px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save settings"}
                </button>
              </div>
            </div>
          )}

          {tab === "transparency" && (
            <div>
              <p className="mb-4 font-serif text-[13px] leading-relaxed text-graphite">
                Everything BlattBot sends and stores, in the open. Settings live in a plain JSON
                file; session cookies and API keys stay on this machine (mode 0600) and are never
                sent to the UI.
              </p>
              {info ? (
                <>
                  <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
                    <dt className="text-graphite">backend</dt>
                    <dd className="text-paper-dim">{info.backend}</dd>
                    <dt className="text-graphite">model</dt>
                    <dd className="text-paper-dim">{info.model}</dd>
                    <dt className="text-graphite">endpoint</dt>
                    <dd className="text-paper-dim">
                      {info.anthropicBaseUrl}
                      {info.usingApiKey ? " (API key)" : " (Claude Code login)"}
                    </dd>
                    <dt className="text-graphite">base prompt</dt>
                    <dd className="text-paper-dim">Claude Code preset ({info.systemPromptPreset})</dd>
                    <dt className="text-graphite">data dir</dt>
                    <dd className="break-all text-paper-dim">{info.dataDir}</dd>
                    <dt className="text-graphite">settings</dt>
                    <dd className="break-all text-paper-dim">{settings?.settingsPath}</dd>
                  </dl>

                  <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-graphite">
                    System prompt (BlattBot's append)
                  </h3>
                  <pre className="mb-4 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-rule bg-ink px-3 py-2 font-mono text-[11px] leading-relaxed text-paper-dim">
                    {info.systemPromptAppend}
                    {info.userSystemPromptAppend
                      ? `\n\nAdditional instructions from the user's BlattBot settings:\n${info.userSystemPromptAppend}`
                      : ""}
                  </pre>

                  <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-graphite">
                    Operating modes
                  </h3>
                  <ul className="mb-4">
                    {info.modes.map((m) => (
                      <li key={m.id} className="border-b border-rule/40 py-1.5 last:border-0">
                        <span className="font-serif text-[13.5px] text-paper">{m.label}</span>
                        <span className="ml-2 text-[12px] text-graphite">{m.description}</span>
                        {m.prompt && (
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-rule bg-ink px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-paper-dim/90">
                            {m.prompt}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>

                  <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-graphite">
                    Project tools
                  </h3>
                  <ul className="mb-4">
                    {info.tools.map((t) => (
                      <li key={t.name} className="border-b border-rule/40 py-1.5 last:border-0">
                        <span className="font-mono text-[11.5px] text-gold">{t.name}</span>
                        <p className="text-[12px] leading-snug text-graphite">{t.description}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="mb-1 text-[12px] text-graphite">
                    Plus Claude Code's standard file tools (Read, Edit, Grep, …). Blocked for the
                    agent — the harness owns version control:
                  </p>
                  <p className="font-mono text-[11px] text-pencil/90">
                    {info.disallowedTools.join("  ")}
                  </p>
                </>
              ) : (
                <p className="text-sm text-graphite">Loading…</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
