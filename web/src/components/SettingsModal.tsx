import { useModelList } from "../models";
import { useEffect, useRef, useState } from "react";
import { api, type Account, type AgentInfo, type ProjectStats, type Settings, type BackendId, type CodexStatus } from "../api";
import { tabStripKeyDown } from "../a11y";
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
  const [backend, setBackend] = useState<BackendId>("codex");
  const [codexModel, setCodexModel] = useState("");
  const [codexEffort, setCodexEffort] = useState<Settings["codexEffort"]>("");
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [checkingCodex, setCheckingCodex] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
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
  const [effort, setEffort] = useState<Settings["effort"]>("");
  const modelList = useModelList(backend);
  const [fallbackModel, setFallbackModel] = useState("");
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
      setBackend(s.backend || "codex");
      setCodexModel(s.codexModel ?? "");
      setCodexEffort(s.codexEffort ?? "");
      setModel(s.model);
      setBaseUrl(s.anthropicBaseUrl);
      setOaiBaseUrl(s.openaiBaseUrl);
      setOaiModel(s.openaiModel);
      setPromptAppend(s.systemPromptAppend);
      setEngine(s.engine);
      setEffort(s.effort ?? "");
      setFallbackModel(s.fallbackModel ?? "");
    }).catch((err) => setError(`Could not load settings: ${err.message}`));
    api.agentInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    if (tab !== "agent" || backend !== "codex") return;
    let stale = false;
    setCheckingCodex(true);
    api.codexStatus().then((status) => { if (!stale) setCodexStatus(status); })
      .catch((err) => { if (!stale) setError(err.message); })
      .finally(() => { if (!stale) setCheckingCodex(false); });
    return () => { stale = true; };
  }, [tab, backend]);

  async function checkCodex() {
    setCheckingCodex(true);
    try { setCodexStatus(await api.codexStatus(true)); }
    catch (err: any) { setError(err.message); }
    finally { setCheckingCodex(false); }
  }

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
    const previous = document.activeElement as HTMLElement | null;
    modalRef.current?.querySelector<HTMLElement>('button[aria-label="Close settings"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const stops = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
        ) ?? []).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
        const first = stops[0], last = stops.at(-1);
        if (first && last && (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
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
        codexModel: codexModel.trim(),
        codexEffort,
        model: model.trim(),
        anthropicBaseUrl: baseUrl.trim(),
        openaiBaseUrl: oaiBaseUrl.trim(),
        openaiModel: oaiModel.trim(),
        systemPromptAppend: promptAppend,
        engine,
        effort,
        fallbackModel: fallbackModel.trim(),
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
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[88vh] w-[720px] max-w-full flex-col rounded-lg border border-rule bg-ink-2 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
      >
        <header className="booktabs flex flex-wrap items-center gap-2 px-5 pb-3 pt-4 sm:gap-4">
          <h2 className="font-serif text-[17px] font-semibold text-paper">Settings</h2>
          <nav className="flex gap-1" role="tablist" aria-label="Settings sections">
            {(
              [
                ["accounts", "Accounts"],
                ["agent", "Agent"],
                ["transparency", "Transparency"],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                id={`settings-tab-${key}`}
                aria-selected={tab === key}
                aria-controls="settings-panel"
                tabIndex={tab === key ? 0 : -1}
                onKeyDown={tabStripKeyDown}
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

        <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p role="alert" className="mb-3 text-[12px] leading-snug text-pencil">{error}</p>}
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

              {/* Backend picker */}
              <fieldset className="mb-4">
                <legend className="sr-only">Agent backend</legend>
                <div className="flex flex-col gap-2">
                  <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors ${backend === "codex" ? "border-leaf/60 bg-leaf/5" : "border-rule hover:border-leaf/30"}`}>
                    <input type="radio" name="agent-backend" value="codex" checked={backend === "codex"}
                      onChange={() => setBackend("codex")} className="mt-0.5 accent-[#8fb573]" aria-label="Codex" />
                    <span>
                      <span className="block text-[13px] font-medium text-paper">Codex
                        <span className="ml-2 rounded border border-leaf/40 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-leaf">default</span>
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-graphite">
                        Uses your local Codex login, with conversation memory, citations, and compile verification.
                      </span>
                    </span>
                  </label>
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

              <p className="mb-4 text-[11px] leading-relaxed text-graphite">
                Changes apply to the next turn. Switching backends starts a new conversation; earlier messages remain visible in your chat.
              </p>

              {backend === "codex" && (
                <div className="space-y-3">
                  <div className="rounded-md border border-rule bg-ink p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p role="status" className={`text-[12px] leading-relaxed ${codexStatus?.authenticated ? "text-leaf" : "text-paper-dim"}`}>
                        {checkingCodex ? "Checking Codex…" : codexStatus?.message ?? "Check your local Codex installation."}
                      </p>
                      <button type="button" onClick={() => void checkCodex()} disabled={checkingCodex}
                        className="shrink-0 rounded border border-rule px-2 py-1 text-[11px] text-paper-dim hover:border-leaf disabled:opacity-50">Check again</button>
                    </div>
                    {!codexStatus?.authenticated && (
                      <div className="mt-2 text-[11px] leading-relaxed text-graphite">
                        <p>Install and sign in once in your terminal:</p>
                        <pre className="mt-1 select-all rounded border border-rule p-2 font-mono text-paper-dim">{"npm install -g @openai/codex\ncodex login"}</pre>
                        <p className="mt-1">BlattBot reuses that login. No API key is needed here.</p>
                      </div>
                    )}
                  </div>
                  <label className="block text-[11px] text-graphite">Codex model <span className="text-graphite/60">(empty = your Codex default)</span>
                    <input value={codexModel} onChange={(e) => setCodexModel(e.target.value)} list="blattbot-codex-models"
                      placeholder={modelList.defaultModel || codexStatus?.defaultModel || "Use Codex CLI default"}
                      className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60" />
                    <datalist id="blattbot-codex-models">{modelList.models.map((m) => <option key={m.id} value={m.id} label={m.label} />)}</datalist>
                  </label>
                  <label className="block text-[11px] text-graphite">Codex reasoning effort
                    <select value={codexEffort} onChange={(e) => setCodexEffort(e.target.value as Settings["codexEffort"])}
                      className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper">
                      <option value="">Codex default</option>
                      {[...new Set([...(modelList.models.find((m) => m.id === (codexModel || modelList.defaultModel))?.effortLevels ?? ["low", "medium", "high", "xhigh"]), ...(codexEffort ? [codexEffort] : [])])]
                        .map((level) => <option key={level} value={level}>{level}</option>)}
                    </select>
                  </label>
                  <p className="text-[11px] leading-relaxed text-graphite">Codex reports token usage. Dollar costs are unavailable for these turns.</p>
                </div>
              )}

              {backend === "claude" && (
                <>
                  <label className="block text-[11px] text-graphite">
                    Model{" "}
                    <span className="text-graphite/60">
                      (empty = claude-sonnet-5; aliases sonnet/opus/fable/haiku map to the newest of each tier
                      {modelList.source === "cli" ? "; suggestions come from the engine's own catalog" : ""})
                    </span>
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      list="blattbot-models"
                      placeholder="claude-sonnet-5"
                      className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                    />
                    <datalist id="blattbot-models">
                      {modelList.models.map((m) => (
                    <option key={m.id} value={m.id} label={m.label !== m.id ? m.label : undefined} />
                  ))}
                    </datalist>
                  </label>

                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="block text-[11px] text-graphite">
                      Effort{" "}
                      <span className="text-graphite/60">(reasoning depth; empty = the model's default)</span>
                      <select
                        value={effort}
                        onChange={(e) => setEffort(e.target.value as Settings["effort"])}
                        className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper"
                      >
                        <option value="">model default</option>
                        <option value="low">low — quick, routine edits</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="xhigh">xhigh — long agentic work</option>
                        <option value="max">max — correctness over cost</option>
                      </select>
                    </label>
                    <label className="block text-[11px] text-graphite">
                      Fallback model{" "}
                      <span className="text-graphite/60">(overload, or a Fable safety decline)</span>
                      <input
                        value={fallbackModel}
                        onChange={(e) => setFallbackModel(e.target.value)}
                        list="blattbot-models"
                        placeholder="automatic: claude-opus-5 behind Fable"
                        title="Empty = automatic: Opus 5 when the model is a Fable-family model, none otherwise. Type “none” to disable."
                        className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
                      />
                    </label>
                  </div>

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

              <div className="sticky -bottom-4 mt-4 flex items-center gap-3 border-t border-rule bg-ink-2 py-3">
                {savedMsg && <span role="status" className="text-[12px] text-leaf">{savedMsg}</span>}
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
                    {info.effort && (
                      <>
                        <dt className="text-graphite">effort</dt>
                        <dd className="text-paper-dim">{info.effort}</dd>
                      </>
                    )}
                    {info.fallbackModel && (
                      <>
                        <dt className="text-graphite">fallback</dt>
                        <dd className="text-paper-dim">{info.fallbackModel}</dd>
                      </>
                    )}
                    {info.engine && (
                      <>
                        <dt className="text-graphite">engine</dt>
                        <dd className="break-all text-paper-dim">{info.engine}</dd>
                      </>
                    )}
                    <dt className="text-graphite">endpoint</dt>
                    <dd className="break-all text-paper-dim">
                      {info.endpoint ?? info.anthropicBaseUrl}
                      {info.authLabel ? ` (${info.authLabel})` : info.usingApiKey
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
