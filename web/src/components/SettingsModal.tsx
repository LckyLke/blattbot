import { useEffect, useState } from "react";
import { api, type Account, type AgentInfo, type ProjectStats, type Settings } from "../api";
import AccountSignIn from "./AccountSignIn";
import { useDialog } from "./Dialog";

interface Props {
  onClose: () => void;
  /** Called whenever accounts changed, so the app can refresh its lists. */
  onAccountsChanged: () => void;
  /** The open project, when settings were opened from inside one — enables
   *  the per-project transparency section (totals, AI-use disclosure). */
  projectId?: string | null;
  projectName?: string;
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

export default function SettingsModal({ onClose, onAccountsChanged, projectId, projectName }: Props) {
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AgentInfo | null>(null);
  // Per-project transparency: cumulative totals + the disclosure generator.
  const [projStats, setProjStats] = useState<ProjectStats | null>(null);
  const [disclosureBusy, setDisclosureBusy] = useState(false);

  // Agent form state
  const [backend, setBackend] = useState<"claude" | "openai">("claude");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [s2Key, setS2Key] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [oaiBaseUrl, setOaiBaseUrl] = useState("");
  const [oaiModel, setOaiModel] = useState("");
  const [oaiKey, setOaiKey] = useState("");
  const [clearOaiKey, setClearOaiKey] = useState(false);
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
      setBackend(s.backend === "openai" ? "openai" : "claude");
      setModel(s.model);
      setBaseUrl(s.anthropicBaseUrl);
      setOaiBaseUrl(s.openaiBaseUrl);
      setOaiModel(s.openaiModel);
      setPromptAppend(s.systemPromptAppend);
      setEngine(s.engine);
    });
    api.agentInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let stale = false;
    api
      .project(projectId)
      .then((d) => {
        if (!stale) setProjStats(d.stats ?? { totalCostUsd: 0, totalTurns: 0 });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** POST the disclosure endpoint and show the text in a copyable dialog. */
  async function generateDisclosure() {
    if (!projectId) return;
    setDisclosureBusy(true);
    setError(null);
    try {
      const r = await api.disclosure(projectId);
      await dialog.alert({
        title: "AI-use disclosure",
        body: <DisclosureBody text={r.text} />,
        dismissLabel: "Close",
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDisclosureBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const patch: any = {
        backend,
        model: model.trim(),
        anthropicBaseUrl: baseUrl.trim(),
        openaiBaseUrl: oaiBaseUrl.trim(),
        openaiModel: oaiModel.trim(),
        systemPromptAppend: promptAppend,
        engine,
      };
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      else if (clearKey) patch.apiKey = "";
      if (oaiKey.trim()) patch.openaiApiKey = oaiKey.trim();
      else if (clearOaiKey) patch.openaiApiKey = "";
      if (s2Key.trim()) patch.s2ApiKey = s2Key.trim();
      const next = await api.saveSettings(patch);
      setSettings(next);
      setApiKey("");
      setS2Key("");
      setClearKey(false);
      setOaiKey("");
      setClearOaiKey(false);
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
                Pick the engine that runs BlattBot's agent turns. Everything below it — prompts,
                tools, review flow — stays the same.
              </p>

              {/* Backend picker: two radio cards. */}
              <fieldset className="mb-4">
                <legend className="sr-only">Agent backend</legend>
                <div className="flex flex-col gap-2">
                  <label
                    className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors ${
                      backend === "claude" ? "border-leaf/60 bg-leaf/5" : "border-rule hover:border-leaf/30"
                    }`}
                  >
                    <input
                      type="radio"
                      name="agent-backend"
                      value="claude"
                      checked={backend === "claude"}
                      onChange={() => setBackend("claude")}
                      className="mt-0.5 accent-[#8fb573]"
                      aria-label="Claude Code (Agent SDK)"
                    />
                    <span>
                      <span className="block text-[13px] font-medium text-paper">
                        Claude Code (Agent SDK)
                        <span className="ml-2 rounded border border-rule px-1.5 py-px text-[9.5px] uppercase tracking-wide text-graphite">
                          default
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-graphite">
                        Runs locally via the Claude Agent SDK — reuses your Claude Code login unless
                        an API key is set below.
                      </span>
                    </span>
                  </label>
                  <label
                    className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors ${
                      backend === "openai" ? "border-leaf/60 bg-leaf/5" : "border-rule hover:border-leaf/30"
                    }`}
                  >
                    <input
                      type="radio"
                      name="agent-backend"
                      value="openai"
                      checked={backend === "openai"}
                      onChange={() => setBackend("openai")}
                      className="mt-0.5 accent-[#8fb573]"
                      aria-label="OpenAI-compatible API"
                    />
                    <span>
                      <span className="block text-[13px] font-medium text-paper">
                        OpenAI-compatible API
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-graphite">
                        Any server speaking the OpenAI chat-completions API with tool calling:
                        llama.cpp, Ollama, vLLM, LM Studio, OpenRouter, … File edits go through
                        BlattBot's own sandboxed tools.
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>

              {backend === "claude" && (
                <>
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
                </>
              )}

              {backend === "openai" && (
                <>
                  <label className="block text-[11px] text-graphite">
                    Base URL{" "}
                    <span className="text-graphite/60">
                      (BlattBot calls {"{base}"}/chat/completions — include the /v1 if your server uses it)
                    </span>
                    <input
                      value={oaiBaseUrl}
                      onChange={(e) => setOaiBaseUrl(e.target.value)}
                      placeholder="http://127.0.0.1:11434/v1"
                      className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                    />
                  </label>

                  <label className="mt-3 block text-[11px] text-graphite">
                    API key{" "}
                    <span className="text-graphite/60">
                      {settings.hasOpenaiApiKey
                        ? "(a key is set — it never leaves this machine)"
                        : "(optional — most local servers need none)"}
                    </span>
                    <span className="mt-1 flex gap-1.5">
                      <input
                        value={oaiKey}
                        onChange={(e) => setOaiKey(e.target.value)}
                        type="password"
                        placeholder={settings.hasOpenaiApiKey ? "•••••••• (set)" : "sk-…"}
                        className="min-w-0 flex-1 rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                      />
                      {settings.hasOpenaiApiKey && (
                        <button
                          type="button"
                          onClick={() => {
                            setClearOaiKey(true);
                            setOaiKey("");
                          }}
                          className={`rounded border px-2.5 text-[11px] transition-colors ${
                            clearOaiKey
                              ? "border-pencil text-pencil"
                              : "border-rule text-graphite hover:border-pencil hover:text-pencil"
                          }`}
                        >
                          {clearOaiKey ? "will clear" : "clear"}
                        </button>
                      )}
                    </span>
                  </label>

                  <label className="mt-3 block text-[11px] text-graphite">
                    Model{" "}
                    <span className="text-graphite/60">
                      (sent verbatim — whatever your server expects; needs tool calling)
                    </span>
                    <input
                      value={oaiModel}
                      onChange={(e) => setOaiModel(e.target.value)}
                      placeholder="e.g. llama3.3:70b, qwen2.5-coder, gpt-4o-mini"
                      className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                    />
                  </label>
                </>
              )}

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
                  <option value="">auto (latexmk → pdflatex → tectonic)</option>
                  <option value="tectonic">tectonic</option>
                  <option value="latexmk">latexmk</option>
                  <option value="pdflatex">pdflatex</option>
                </select>
                <span className="mt-1 block text-[11px] text-graphite/70">
                  Whichever you pick is tried first; the others stay as fallbacks when it is not
                  installed or cannot build the document.
                </span>
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
              {projectId && (
                <div className="mb-4 rounded-md border border-rule bg-ink p-3">
                  <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-graphite">
                    This project{projectName ? ` — ${projectName}` : ""}
                  </h3>
                  <dl className="mb-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
                    <dt className="text-graphite">agent turns</dt>
                    <dd className="text-paper-dim">{projStats ? projStats.totalTurns : "…"}</dd>
                    <dt className="text-graphite">total cost</dt>
                    <dd className="text-paper-dim">
                      {projStats
                        ? projStats.totalCostUsd > 0
                          ? `$${projStats.totalCostUsd.toFixed(2)}`
                          : "unknown (no cost reported)"
                        : "…"}
                    </dd>
                  </dl>
                  <button
                    onClick={() => void generateDisclosure()}
                    disabled={disclosureBusy}
                    className="rounded border border-rule px-3 py-1.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                  >
                    {disclosureBusy ? "Generating…" : "Generate AI-use disclosure"}
                  </button>
                  <p className="mt-1.5 text-[10.5px] leading-snug text-graphite/70">
                    A factual paragraph for venue AI-use disclosure requirements, built from this
                    project's real usage record.
                  </p>
                </div>
              )}
              {info ? (
                <>
                  <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
                    <dt className="text-graphite">backend</dt>
                    <dd className="text-paper-dim">
                      {info.backendLabel ? `${info.backendLabel} — ${info.backend}` : info.backend}
                    </dd>
                    <dt className="text-graphite">model</dt>
                    <dd className="text-paper-dim">{info.model}</dd>
                    <dt className="text-graphite">endpoint</dt>
                    <dd className="break-all text-paper-dim">
                      {info.endpoint ?? info.anthropicBaseUrl}
                      {info.usingApiKey
                        ? " (API key)"
                        : info.systemPromptPreset
                          ? " (Claude Code login)"
                          : " (no API key)"}
                    </dd>
                    <dt className="text-graphite">base prompt</dt>
                    <dd className="text-paper-dim">
                      {info.systemPromptPreset
                        ? `Claude Code preset (${info.systemPromptPreset})`
                        : "BlattBot's own prompt (shown in full below)"}
                    </dd>
                    {info.sessionNote && (
                      <>
                        <dt className="text-graphite">sessions</dt>
                        <dd className="break-all text-paper-dim">{info.sessionNote}</dd>
                      </>
                    )}
                    <dt className="text-graphite">data dir</dt>
                    <dd className="break-all text-paper-dim">{info.dataDir}</dd>
                    <dt className="text-graphite">settings</dt>
                    <dd className="break-all text-paper-dim">{settings?.settingsPath}</dd>
                  </dl>

                  <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-graphite">
                    {info.systemPromptPreset ? "System prompt (BlattBot's append)" : "System prompt"}
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
                  {info.disallowedTools.length > 0 ? (
                    <>
                      <p className="mb-1 text-[12px] text-graphite">
                        Plus Claude Code's standard file tools (Read, Edit, Grep, …). Blocked for the
                        agent — the harness owns version control:
                      </p>
                      <p className="font-mono text-[11px] text-pencil/90">
                        {info.disallowedTools.join("  ")}
                      </p>
                    </>
                  ) : (
                    <p className="mb-1 text-[12px] text-graphite">
                      The list above is the complete toolset — this backend has no shell and no other
                      file access; every path is validated against the project directory.
                    </p>
                  )}
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

/** Dialog body of the generated disclosure: the text plus a clipboard button. */
function DisclosureBody({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-rule bg-ink px-3 py-2 font-serif text-[13px] leading-relaxed text-paper-dim">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="mt-2 rounded border border-rule px-2.5 py-1 text-[11.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
      >
        {copied ? "Copied." : "Copy to clipboard"}
      </button>
    </div>
  );
}
