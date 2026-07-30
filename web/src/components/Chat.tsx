import { useEffect, useMemo, useRef, useState } from "react";
import { parseDiff } from "../diff";
import type { ChatMeta } from "../api";
import DiffView from "./DiffView";

export type ChatItem =
  | { kind: "user"; text: string; scope?: string[] }
  | { kind: "agent"; text: string; streaming: boolean }
  | {
      kind: "tool";
      id?: string;
      name: string;
      detail: string;
      status: "running" | "done" | "error";
      /** Unified diff of the file this edit touched — expandable under the chip. */
      fileDiff?: string;
    }
  | { kind: "notice"; tone: "info" | "warn" | "error" | "ok"; text: string }
  | { kind: "turn_end"; costUsd?: number; durationMs?: number };

interface Props {
  items: ChatItem[];
  busy: boolean;
  /** What the agent is doing right now — drives the thinking indicator. */
  activity: "idle" | "thinking" | "streaming" | "tool";
  projectName: string;
  /** Files the next message is scoped to (empty = whole project). */
  scope: string[];
  onClearScope: () => void;
  onSend: (message: string, mode: string) => void;
  onInterrupt: () => void;
  /** All chats of the project (newest-updated first) and the active one. */
  chats: ChatMeta[];
  activeChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
  /** Resolved model id the next turn will run (e.g. "claude-sonnet-5"). */
  model: string;
  onChangeModel: (model: string) => void;
  /** A PDF selection to quote into the draft; each new nonce injects once. */
  quote?: { text: string; nonce: number } | null;
}

/** Short display label for a model id: "claude-sonnet-5" → "sonnet-5". */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}

/** The curated picks in the model popover; anything else goes in the free-text field. */
const MODEL_SUGGESTIONS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
];

/** Compact relative timestamp for the chat list. */
export function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Compact scope label: "intro.tex +2". */
export function scopeLabel(scope: string[]): string {
  if (scope.length === 0) return "";
  const first = scope[0].split("/").pop() ?? scope[0];
  return scope.length > 1 ? `${first} +${scope.length - 1}` : first;
}

/** Mirrors AGENT_MODES on the server (which validates the id). */
const MODES = [
  { id: "edit", label: "Edit", hint: "General writing and editing — the default." },
  { id: "research", label: "Research", hint: "Find literature and fill missing citations." },
  { id: "polish", label: "Polish", hint: "Grammar, style, and LaTeX consistency only." },
  { id: "review", label: "Review", hint: "Read-only feedback — file edits are blocked." },
];

const TOOL_LABELS: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Glob: "Scanning",
  Grep: "Searching",
  Bash: "Running",
  WebSearch: "Searching web",
  WebFetch: "Fetching",
  TodoWrite: "Planning",
  Task: "Delegating",
  mcp__blattbot__compile_latex: "Compiling LaTeX",
  mcp__blattbot__search_papers: "Searching literature",
  mcp__blattbot__add_citation: "Adding citation",
  mcp__blattbot__list_citations: "Reading bibliography",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/^mcp__\w+__/, "");
}

/** Tiny markdown-ish renderer: fenced code, inline code, bold. Safe by construction (text nodes). */
function AgentText({ text, streaming }: { text: string; streaming: boolean }) {
  const parts = text.split(/```(?:[a-zA-Z]*\n)?/);
  return (
    <div className={`prose-agent ${streaming ? "tex-caret" : ""}`}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i}>
            <code>{part.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          part
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((para, j) => <p key={`${i}-${j}`}>{renderInline(para)}</p>)
        ),
      )}
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) nodes.push(<code key={k++}>{token.slice(1, -1)}</code>);
    else nodes.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Chat({
  items,
  busy,
  activity,
  projectName,
  scope,
  onClearScope,
  onSend,
  onInterrupt,
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  model,
  onChangeModel,
  quote,
}: Props) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem("blattbot.chatMode");
    return MODES.some((m) => m.id === saved) ? saved! : "edit";
  });
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  /** Chat id whose delete button is in its "really?" confirm stage. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Quote-from-PDF injection: append the quoted block to whatever draft
  // exists, once per nonce (the mount-time nonce is deliberately skipped so
  // remounting a pane never re-injects an old quote).
  const lastQuoteNonce = useRef(quote?.nonce ?? 0);
  useEffect(() => {
    if (!quote || quote.nonce === lastQuoteNonce.current) return;
    lastQuoteNonce.current = quote.nonce;
    setDraft((d) => `${d && !d.endsWith("\n") ? `${d}\n` : d}> "${quote.text}" (from the PDF)\n\n`);
    composerRef.current?.focus();
  }, [quote]);

  const activeTitle = chats.find((c) => c.id === activeChatId)?.title ?? "New chat";

  function closeChatMenu() {
    setChatMenuOpen(false);
    setConfirmDelete(null);
  }

  function pickMode(id: string) {
    setMode(id);
    localStorage.setItem("blattbot.chatMode", id);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, activity]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text, mode);
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Chat switcher: slim strip above the transcript. */}
      <div className="relative flex h-9 shrink-0 items-center gap-2 border-b border-rule bg-ink-2 px-4">
        <button
          type="button"
          title="Switch chat"
          onClick={() => (chatMenuOpen ? closeChatMenu() : setChatMenuOpen(true))}
          className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[12.5px] text-paper-dim transition-colors hover:text-paper"
        >
          <span className="max-w-[300px] truncate">{activeTitle}</span>
          <span className="text-[9px] text-graphite">▾</span>
        </button>
        {chats.length > 1 && (
          <span className="font-mono text-[10px] text-graphite/70">{chats.length} chats</span>
        )}
        {chatMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={closeChatMenu} />
            <div className="absolute left-3 top-full z-20 mt-1 w-80 rounded-lg border border-rule bg-ink-2 py-1 shadow-xl">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  closeChatMenu();
                  onNewChat();
                }}
                className="w-full px-3 py-1.5 text-left text-[12.5px] text-leaf transition-colors hover:bg-ink-3 disabled:opacity-40"
              >
                + new chat
              </button>
              {busy && (
                <p className="border-t border-rule px-3 py-1.5 text-[11px] italic text-graphite">
                  BlattBot is working — switching chats unlocks when the turn finishes.
                </p>
              )}
              <ul className="max-h-72 overflow-y-auto border-t border-rule">
                {chats.map((c) => (
                  <li key={c.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-ink-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        closeChatMenu();
                        onSelectChat(c.id);
                      }}
                      className={`flex min-w-0 flex-1 items-baseline gap-2 text-left disabled:opacity-40 ${
                        c.id === activeChatId ? "text-paper" : "text-paper-dim"
                      }`}
                    >
                      {c.id === activeChatId && (
                        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-leaf" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.title}</span>
                      <span className="shrink-0 font-mono text-[10px] text-graphite">
                        {relTime(c.updatedAt)}
                      </span>
                    </button>
                    {confirmDelete === c.id ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setConfirmDelete(null);
                          closeChatMenu();
                          onDeleteChat(c.id);
                        }}
                        aria-label={`Really delete ${c.title}?`}
                        className="shrink-0 rounded border border-pencil/50 px-1.5 text-[10.5px] text-pencil transition-colors hover:bg-pencil/10 disabled:opacity-40"
                      >
                        sure?
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDelete(c.id)}
                        aria-label={`Delete ${c.title}`}
                        title="Delete this chat"
                        className="shrink-0 rounded px-1 text-[13px] leading-none text-graphite opacity-0 transition-all hover:text-pencil group-hover:opacity-100 disabled:opacity-40"
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {items.length === 0 && (
          <div className="mx-auto mt-16 max-w-md text-center">
            <p className="font-serif text-[15px] leading-relaxed text-graphite">
              Ask for an edit, a rewrite, a restructure — or a citation.
              <br />
              BlattBot works on a synced copy of{" "}
              <span className="italic text-paper-dim">{projectName}</span> and shows you every change
              as a proof before it reaches Overleaf.
            </p>
          </div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {items.map((item, i) => (
            <ChatBubble key={i} item={item} />
          ))}
          {busy && activity === "thinking" && (
            <div className="flex items-center gap-2 self-start px-1 font-serif text-[13.5px] italic text-graphite">
              <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-graphite" />
              <span className="thinking-ellipsis">thinking</span>
            </div>
          )}
        </div>
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-rule bg-ink-2 px-6 py-3">
        {scope.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center">
            <span
              title={scope.join("\n")}
              className="flex items-center gap-1.5 rounded-full border border-gold/40 py-0.5 pl-2.5 pr-1.5 font-mono text-[11px] text-gold"
            >
              scope: {scopeLabel(scope)}
              <button
                type="button"
                onClick={onClearScope}
                aria-label="Clear scope"
                className="rounded-full px-1 leading-none text-gold/70 transition-colors hover:text-paper"
              >
                ×
              </button>
            </span>
          </div>
        )}
        <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => pickMode(m.id)}
              title={m.hint}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                mode === m.id
                  ? "border-leaf/60 bg-leaf/10 text-paper"
                  : "border-rule text-graphite hover:border-leaf/40 hover:text-paper-dim"
              }`}
            >
              {m.label}
            </button>
          ))}
          <span className="ml-2 hidden min-w-0 truncate text-[10.5px] text-graphite/70 sm:inline">
            {MODES.find((m) => m.id === mode)?.hint}
          </span>
          <ModelChip model={model} onChange={onChangeModel} />
        </div>
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(6, Math.max(1, draft.split("\n").length))}
            placeholder={busy ? "BlattBot is working…" : "Ask BlattBot to edit, rewrite, or cite…"}
            disabled={busy}
            className="min-h-[42px] flex-1 resize-none rounded-lg border border-rule bg-ink px-3.5 py-2.5 font-serif text-[16px] text-paper placeholder:text-graphite/70 disabled:opacity-60"
          />
          {busy ? (
            <button
              type="button"
              onClick={onInterrupt}
              className="h-[42px] rounded-lg border border-pencil/60 px-4 text-[13px] text-pencil transition-colors hover:bg-pencil/10"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              className="h-[42px] rounded-lg bg-leaf-deep px-4 text-[13px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * The current model as a mono chip; clicking opens a popover with the curated
 * suggestions plus a free-text field. Selecting saves globally (PUT /api/settings)
 * and applies from the next turn.
 */
function ModelChip({ model, onChange }: { model: string; onChange: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");

  function pick(id: string) {
    const next = id.trim();
    setOpen(false);
    setCustom("");
    if (next && next !== model) onChange(next);
  }

  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-label="Agent model"
        title={`Agent model: ${model || "default"} — click to change`}
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-rule px-2.5 py-0.5 font-mono text-[11px] text-graphite transition-colors hover:border-leaf/40 hover:text-paper-dim"
      >
        {shortModel(model) || "model"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-20 mb-1.5 w-72 rounded-lg border border-rule bg-ink-2 py-1 shadow-xl">
            <p className="px-3 pb-1 pt-1.5 text-[10.5px] uppercase tracking-wide text-graphite">
              Model — applies from the next turn
            </p>
            {MODEL_SUGGESTIONS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => pick(id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] transition-colors hover:bg-ink-3 ${
                  id === model ? "text-paper" : "text-paper-dim"
                }`}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    id === model ? "bg-leaf" : "bg-transparent"
                  }`}
                />
                {id}
              </button>
            ))}
            <div className="mt-1 flex items-center gap-1.5 border-t border-rule px-3 pb-1.5 pt-2">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  // Enter must not submit the surrounding composer form.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    pick(custom);
                  }
                }}
                placeholder="any model id…"
                aria-label="Custom model id"
                className="min-w-0 flex-1 rounded border border-rule bg-ink px-2 py-1 font-mono text-[11px] text-paper placeholder:text-graphite/60"
              />
              <button
                type="button"
                disabled={!custom.trim()}
                onClick={() => pick(custom)}
                className="rounded border border-rule px-2 py-1 text-[11px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-40"
              >
                Set
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-12 self-end rounded-xl rounded-br-sm bg-ink-3 px-4 py-2.5 text-[14px] leading-relaxed text-paper">
          {item.text}
          {item.scope && item.scope.length > 0 && (
            <span
              title={item.scope.join("\n")}
              className="mt-1 block text-right font-mono text-[10px] text-gold/80"
            >
              scope: {scopeLabel(item.scope)}
            </span>
          )}
        </div>
      );
    case "agent":
      return (
        <div className="mr-6 text-paper">
          <AgentText text={item.text} streaming={item.streaming} />
        </div>
      );
    case "tool":
      return <ToolChip item={item} />;
    case "notice": {
      const tone =
        item.tone === "error"
          ? "text-pencil border-pencil/40"
          : item.tone === "warn"
            ? "text-gold border-gold/40"
            : item.tone === "ok"
              ? "text-leaf border-leaf/40"
              : "text-graphite border-rule";
      return (
        <div className={`self-center rounded border px-3 py-1 text-center text-xs ${tone}`}>
          {item.text}
        </div>
      );
    }
    case "turn_end":
      return (
        <div className="self-center font-mono text-[10.5px] tracking-wide text-graphite/70">
          — turn complete
          {item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
          {item.costUsd != null && ` · $${item.costUsd.toFixed(3)}`} —
        </div>
      );
  }
}

/** A tool-use pill; edit tools grow a ▸/▾ expander showing the file's diff. */
function ToolChip({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const files = useMemo(() => (item.fileDiff ? parseDiff(item.fileDiff) : []), [item.fileDiff]);
  const expandable = files.length > 0;
  return (
    <div className={`flex max-w-full flex-col self-start ${open && expandable ? "w-full" : ""}`}>
      <div className="flex items-center gap-2 self-start rounded-full border border-rule bg-ink-2 py-1 pl-2.5 pr-3 font-mono text-[11.5px] text-paper-dim">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            item.status === "running"
              ? "working-dot bg-gold"
              : item.status === "error"
                ? "bg-pencil"
                : "bg-leaf"
          }`}
        />
        <span>{toolLabel(item.name)}</span>
        {item.detail && <span className="max-w-[280px] truncate text-graphite">{item.detail}</span>}
        {expandable && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Hide change" : "Show change"}
            title={open ? "Hide this change" : "Show this change"}
            className="-mr-1 rounded px-1 text-graphite transition-colors hover:text-paper"
          >
            {open ? "▾" : "▸"}
          </button>
        )}
      </div>
      {open && expandable && (
        <div className="mt-1.5 w-full min-w-0 rounded border border-rule bg-ink p-1.5">
          {files.map((file) => (
            <DiffView key={file.path} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}
