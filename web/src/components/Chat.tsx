import { useEffect, useMemo, useRef, useState } from "react";
import { parseDiff } from "../diff";
import {
  CHAT_IMAGE_TYPES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_LABEL,
  api,
} from "../api";
import type { AgentQuestion, ChatMeta, ProjectStats } from "../api";
import DiffView from "./DiffView";
import Markdown from "./Markdown";
import { useDialog } from "./Dialog";

/** An image the user attached to a message, as the transcript records it. */
export interface ChatAttachment {
  id: string;
  mime: string;
}

export type ChatItem =
  | { kind: "user"; text: string; scope?: string[]; images?: ChatAttachment[] }
  | { kind: "agent"; text: string; streaming: boolean }
  | {
      kind: "tool";
      id?: string;
      name: string;
      detail: string;
      status: "running" | "done" | "error";
      /** Unified diff of the file this edit touched — expandable under the chip. */
      fileDiff?: string;
      /** One-line result summary of a read-only tool (Grep/Read/search…). */
      resultHead?: string;
    }
  | { kind: "notice"; tone: "info" | "warn" | "error" | "ok"; text: string }
  | {
      /** A mid-turn agent question — actionable while pending, collapsed after.
       *  "stale": restored from a transcript with no resolution but not the
       *  turn-state's pending question either — likely still waiting server-side
       *  (reload to answer), so it must not claim the user skipped it. */
      kind: "question";
      questionId: string;
      questions: AgentQuestion[];
      status: "pending" | "answered" | "dismissed" | "stale";
      /** Question text → chosen answer (present once answered). */
      answers?: Record<string, string>;
    }
  | {
      kind: "turn_end";
      costUsd?: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
    };

interface Props {
  items: ChatItem[];
  busy: boolean;
  /** What the agent is doing right now — drives the thinking indicator. */
  activity: "idle" | "thinking" | "streaming" | "tool";
  projectId: string;
  projectName: string;
  /** The project's preferred mode for new chats ("" or undefined = none set). */
  defaultMode?: string;
  /** Files the next message is scoped to (empty = whole project). */
  scope: string[];
  onClearScope: () => void;
  /** `images` are the composer's attachments — App uploads them, then sends. */
  /** Resolves false when the message was NOT sent — the composer restores it. */
  onSend: (message: string, mode: string, images: File[]) => Promise<boolean>;
  onInterrupt: () => void;
  /** Submit the answers of a pending mid-turn question (question text → answer). */
  onAnswerQuestion: (questionId: string, answers: Record<string, string>) => void;
  /** Skip a pending mid-turn question — the agent proceeds without answers. */
  onDismissQuestion: (questionId: string) => void;
  /** All chats of the project (newest-updated first) and the active one. */
  chats: ChatMeta[];
  activeChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
  /** Resolved model id the next turn will run (e.g. "claude-sonnet-5"). */
  model: string;
  /** The project's raw model override ("" = none — the global setting applies). */
  projectModel: string;
  onChangeModel: (model: string) => void;
  /** Write the project's model override ("" clears it). */
  onSetProjectModel: (model: string) => void;
  /** Cumulative cost/turn totals of the project (null until loaded). */
  projectStats?: ProjectStats | null;
  /** A selection to quote into the draft; each new nonce injects once. */
  quote?: { text: string; nonce: number; source?: string } | null;
  /** Project files (relative paths) — enables `file[:line]` links in bubbles. */
  files: string[];
  /** Reveal a file (1-based line) in the Source panel. */
  onOpenFile: (file: string, line: number) => void;
  /** Locate a quoted passage in the .tex sources; resolves false on a miss. */
  onLocateQuote: (text: string) => Promise<boolean>;
  /** True while a PDF pane is visible — blockquotes then offer "find in PDF". */
  pdfVisible: boolean;
  /** Highlight a passage in the rendered PDF's text layer. */
  onFindInPdf: (text: string) => void;
}

/** The project-aware props every chat Markdown instance receives (job B). */
interface MdLinkProps {
  files: string[];
  onOpenFile: (file: string, line: number) => void;
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

/** Compact token count: 1234 → "1.2k". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Compact scope label: "intro.tex +2". */
export function scopeLabel(scope: string[]): string {
  if (scope.length === 0) return "";
  const first = scope[0].split("/").pop() ?? scope[0];
  return scope.length > 1 ? `${first} +${scope.length - 1}` : first;
}

/** One not-yet-uploaded composer attachment (the object URL previews it). */
interface PendingImage {
  key: number;
  file: File;
  url: string;
  name: string;
}

/**
 * Sort a paste/drop/picker payload into what can be attached as-is, what is
 * merely too big (a phone photo, a 4K screenshot — the caller downscales those
 * before giving up), and the first reason anything was refused outright.
 * Mirrors the server's rules: accepted types, MAX_CHAT_IMAGE_BYTES each,
 * MAX_CHAT_IMAGES per message. Oversized files still take a slot, so four
 * huge pictures do not turn into eight after shrinking.
 */
export function acceptImageFiles(
  incoming: File[],
  alreadyPending: number,
): { files: File[]; oversized: File[]; error: string } {
  const files: File[] = [];
  const oversized: File[] = [];
  let error = "";
  for (const file of incoming) {
    if (!CHAT_IMAGE_TYPES.includes(file.type)) {
      error ||= `${file.name || "that file"} is not a PNG, JPEG, WebP, or GIF.`;
      continue;
    }
    if (alreadyPending + files.length + oversized.length >= MAX_CHAT_IMAGES) {
      error ||= `At most ${MAX_CHAT_IMAGES} images per message.`;
      continue;
    }
    if (file.size > MAX_CHAT_IMAGE_BYTES) oversized.push(file);
    else files.push(file);
  }
  return { files, oversized, error };
}

/** The message shown when an oversized image could not be shrunk in the browser. */
export function tooLargeMessage(file: File): string {
  return (
    `${file.name || "That image"} is larger than ${MAX_CHAT_IMAGE_LABEL} and could not be ` +
    `resized here — attach a smaller version (the ${MAX_CHAT_IMAGE_LABEL} limit is what the ` +
    `model's API accepts per image).`
  );
}

/**
 * Pixel size for one downscale attempt, preserving the aspect ratio and never
 * upscaling. Encoded size tracks pixel AREA, so the edge scales by
 * sqrt(maxBytes / bytes); `attempt` (0-based) tightens that by a further 15 %
 * each round because re-encoding is never exactly proportional — a photo of a
 * noisy scene compresses worse than the ratio predicts. Pure, so the maths is
 * unit-testable without a canvas.
 */
export function downscaleSize(
  width: number,
  height: number,
  bytes: number,
  maxBytes: number,
  attempt = 0,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const fit = Math.min(1, Math.sqrt(maxBytes / Math.max(bytes, 1)));
  const ratio = fit * Math.pow(0.85, attempt);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** How many re-encodes downscaleImageFile will try before giving up. */
export const DOWNSCALE_ATTEMPTS = 4;
/** JPEG quality for the re-encode — readable for screenshots of text. */
const DOWNSCALE_QUALITY = 0.85;

/**
 * Shrink an oversized image in the browser so an ordinary phone photo or 4K
 * screenshot just works instead of being refused. Re-encodes through a canvas
 * to JPEG (predictable size, and the source is a photo or a screenshot either
 * way), repeating with a smaller target until the result fits.
 *
 * Returns null when it cannot be done — an animated GIF (a re-encode would
 * silently keep one frame), a decode failure, or no canvas at all — and the
 * caller then shows the size error. Never throws.
 */
export async function downscaleImageFile(
  file: File,
  maxBytes: number = MAX_CHAT_IMAGE_BYTES,
): Promise<File | null> {
  if (file.size <= maxBytes) return file;
  if (file.type === "image/gif") return null; // re-encoding would drop the animation
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    let bytes = file.size;
    for (let attempt = 0; attempt < DOWNSCALE_ATTEMPTS; attempt++) {
      const target = downscaleSize(width, height, bytes, maxBytes, attempt);
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/jpeg", DOWNSCALE_QUALITY),
      );
      if (!blob) return null;
      if (blob.size <= maxBytes) {
        const name = (file.name || "image").replace(/\.[^.]*$/, "") + ".jpg";
        return new File([blob], name, { type: "image/jpeg" });
      }
      // Still too big: shrink from where this round landed, not from the original.
      width = target.width;
      height = target.height;
      bytes = blob.size;
    }
    return null;
  } catch {
    return null;
  } finally {
    bitmap.close?.();
  }
}

/** The image files a clipboard or drop payload carries (screenshots included). */
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...(data.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

/** Mirrors AGENT_MODES on the server (which validates the id). */
const MODES = [
  { id: "edit", label: "Edit", hint: "General writing and editing — the default." },
  { id: "research", label: "Research", hint: "Find literature and fill missing citations." },
  { id: "polish", label: "Polish", hint: "Grammar, style, and LaTeX consistency only." },
  { id: "review", label: "Review", hint: "Structured referee report — file edits are blocked." },
  { id: "understand", label: "Understand", hint: "Explain the project's text and math — file edits are blocked." },
];

const isModeId = (v: string | null | undefined): v is string => MODES.some((m) => m.id === v);

/**
 * The composer's preselected mode, in strict precedence order:
 * 1. the user's manual pick for THIS project in this browser
 *    (localStorage "blattbot.chatMode.<projectId>"),
 * 2. the project's defaultMode setting,
 * 3. the legacy global pick ("blattbot.chatMode", pre-per-project versions),
 * 4. "edit".
 */
function preselectedMode(projectId: string, defaultMode?: string): string {
  const own = localStorage.getItem(`blattbot.chatMode.${projectId}`);
  if (isModeId(own)) return own;
  if (isModeId(defaultMode)) return defaultMode;
  const legacy = localStorage.getItem("blattbot.chatMode");
  return isModeId(legacy) ? legacy : "edit";
}

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
  AskUserQuestion: "Asking you",
  mcp__blattbot__compile_latex: "Compiling LaTeX",
  mcp__blattbot__search_papers: "Searching literature",
  mcp__blattbot__add_citation: "Adding citation",
  mcp__blattbot__list_citations: "Reading bibliography",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/^mcp__\w+__/, "");
}

/** Assistant prose: full markdown + math via the shared renderer (Markdown.tsx). */
function AgentText({
  text,
  streaming,
  link,
  onLocateQuote,
  onFindInPdf,
}: {
  text: string;
  streaming: boolean;
  link: MdLinkProps;
  onLocateQuote: (text: string) => Promise<boolean>;
  onFindInPdf?: (text: string) => void;
}) {
  return (
    <Markdown
      text={text}
      className={`prose-agent ${streaming ? "tex-caret" : ""}`}
      files={link.files}
      onOpenFile={link.onOpenFile}
      onLocateQuote={onLocateQuote}
      onFindInPdf={onFindInPdf}
    />
  );
}

export default function Chat({
  items,
  busy,
  activity,
  projectId,
  projectName,
  defaultMode,
  scope,
  onClearScope,
  onSend,
  onInterrupt,
  onAnswerQuestion,
  onDismissQuestion,
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  model,
  projectModel,
  onChangeModel,
  onSetProjectModel,
  projectStats,
  quote,
  files,
  onOpenFile,
  onLocateQuote,
  pdfVisible,
  onFindInPdf,
}: Props) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState(() => preselectedMode(projectId, defaultMode));
  // Re-derive on project switch and when the project's defaultMode arrives or
  // changes (it loads async) — a manual per-project pick always wins.
  useEffect(() => {
    setMode(preselectedMode(projectId, defaultMode));
  }, [projectId, defaultMode]);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  /** Chat id whose delete button is in its "really?" confirm stage. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // ---- Image attachments: paste, drop, or the paperclip picker.
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  /** An oversized image is being re-encoded — the composer says so. */
  const [shrinking, setShrinking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  // Object URLs outlive their component unless revoked — drop them all when
  // the panel unmounts (moving the chat between panes remounts it).
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);
  /** The project on screen right now, readable after an await. */
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Object URLs are created and revoked OUTSIDE the state updaters: React may
  // run an updater twice (StrictMode), and a doubled createObjectURL leaks.
  // pendingRef (not `pending`) supplies the count, because staging can resume
  // after an await while a downscale runs.
  function stage(files: File[]) {
    const room = MAX_CHAT_IMAGES - pendingRef.current.length;
    const added = files.slice(0, Math.max(0, room)).map((file) => ({
      key: nextKey.current++,
      file,
      url: URL.createObjectURL(file),
      name: file.name || "pasted image",
    }));
    if (added.length === 0) return;
    pendingRef.current = [...pendingRef.current, ...added];
    setPending((prev) => [...prev, ...added]);
  }

  async function addFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    // A drop always reaches here, even mid-turn (the handler must
    // preventDefault or the browser navigates to the file) — say why nothing
    // was attached instead of swallowing it.
    if (busy) {
      setAttachError("Wait for the current turn to finish before attaching images.");
      return;
    }
    const startedFor = projectId;
    const { files, oversized, error } = acceptImageFiles(incoming, pendingRef.current.length);
    setAttachError(error);
    stage(files);
    if (oversized.length === 0) return;
    // Too big for one API image block, but a phone photo or a 4K screenshot
    // should still just work: re-encode it smaller rather than refuse.
    setShrinking(true);
    try {
      for (const file of oversized) {
        const smaller = await downscaleImageFile(file);
        // The user switched projects while it was being re-encoded — the
        // picture belongs to the composer they left.
        if (projectIdRef.current !== startedFor) return;
        if (smaller) stage([smaller]);
        else setAttachError(tooLargeMessage(file));
      }
    } finally {
      setShrinking(false);
    }
  }

  function removePending(key: number) {
    const gone = pending.find((p) => p.key === key);
    if (gone) URL.revokeObjectURL(gone.url);
    setPending((prev) => prev.filter((p) => p.key !== key));
    setAttachError("");
  }

  // Attachments are per-project state, like the transcript and the scope: the
  // panel is never remounted on a project switch (panes stay mounted so drafts
  // and scroll survive), so without this a figure staged in project A would be
  // uploaded into project B on the next send.
  useEffect(() => {
    pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url));
    pendingRef.current = [];
    setPending([]);
    setAttachError("");
    setDragging(false);
  }, [projectId]);
  // Stable identity so the memoized Markdown bubbles don't re-render per keystroke.
  const mdLink = useMemo<MdLinkProps>(() => ({ files, onOpenFile }), [files, onOpenFile]);

  // Quote-from-PDF injection: append the quoted block to whatever draft
  // exists, once per nonce (the mount-time nonce is deliberately skipped so
  // remounting a pane never re-injects an old quote).
  const lastQuoteNonce = useRef(quote?.nonce ?? 0);
  useEffect(() => {
    if (!quote || quote.nonce === lastQuoteNonce.current) return;
    lastQuoteNonce.current = quote.nonce;
    setDraft(
      (d) =>
        `${d && !d.endsWith("\n") ? `${d}\n` : d}> "${quote.text}" (from ${quote.source ?? "the PDF"})\n\n`,
    );
    composerRef.current?.focus();
  }, [quote]);

  const activeTitle = chats.find((c) => c.id === activeChatId)?.title ?? "New chat";

  function closeChatMenu() {
    setChatMenuOpen(false);
    setConfirmDelete(null);
  }

  function pickMode(id: string) {
    setMode(id);
    // Manual picks are remembered per project (the legacy global key stays
    // untouched — it only serves as a fallback for projects without a pick).
    localStorage.setItem(`blattbot.chatMode.${projectId}`, id);
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

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    // Pictures alone are a complete message — "here's a screenshot" with no
    // words is the most natural way to use a paste-an-image composer.
    if (busy || shrinking || (!text && pending.length === 0)) return;
    const taken = pending;
    const startedFor = projectId;
    const images = taken.map((p) => p.file);
    setDraft("");
    setPending([]);
    pendingRef.current = [];
    setAttachError("");
    const sent = await onSend(text, mode, images);
    // The previews are handed over to the send; their object URLs are no
    // longer needed (the bubble loads the stored image from the server) — and
    // on a project switch mid-send the message belongs to the project the user
    // left, so it must not reappear in the one they are now looking at.
    if (sent || projectIdRef.current !== startedFor) {
      taken.forEach((p) => URL.revokeObjectURL(p.url));
      return;
    }
    // The send never happened (a failed upload, a rejected request). Put the
    // message back rather than destroying what the user typed — whatever they
    // wrote in the meantime wins.
    setDraft((d) => d || text);
    setPending((prev) => (prev.length > 0 ? prev : taken));
    pendingRef.current = pendingRef.current.length > 0 ? pendingRef.current : taken;
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
            <div
              className="absolute left-3 top-full z-20 mt-1 w-80 rounded-lg border border-rule bg-ink-2 py-1 shadow-xl"
              onKeyDown={(e) => {
                // Keyboard escape hatch — the backdrop is mouse-only.
                if (e.key === "Escape") {
                  e.stopPropagation();
                  closeChatMenu();
                }
              }}
            >
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
            <ChatBubble
              key={i}
              item={item}
              projectId={projectId}
              onAnswerQuestion={onAnswerQuestion}
              onDismissQuestion={onDismissQuestion}
              link={mdLink}
              onLocateQuote={onLocateQuote}
              onFindInPdf={pdfVisible ? onFindInPdf : undefined}
            />
          ))}
          {busy && activity === "thinking" && (
            <div className="flex items-center gap-2 self-start px-1 font-serif text-[13.5px] italic text-graphite">
              <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-graphite" />
              <span className="thinking-ellipsis">thinking</span>
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={submit}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          // ALWAYS preventDefault, busy or not: without it the form is not a
          // drop target, onDrop never fires, and the browser follows its
          // default action — navigating the tab to the dropped file, which
          // unmounts the whole SPA mid-turn.
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // Ignore the leaves fired while crossing the composer's own children.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          // Unfiltered on purpose: a dropped PDF must produce acceptImageFiles'
          // precise "not a PNG, JPEG, WebP, or GIF" message rather than
          // vanishing, and drop is the one entry point with no `accept` filter.
          void addFiles([...(e.dataTransfer.files ?? [])]);
        }}
        className={`shrink-0 border-t bg-ink-2 px-6 py-3 ${
          dragging ? "border-t-leaf border-dashed" : "border-rule"
        }`}
      >
        {dragging && (
          <p
            role="status"
            className="mx-auto mb-2 max-w-2xl rounded border border-dashed border-leaf/70 px-3 py-1 text-center font-mono text-[11px] text-leaf"
          >
            {busy ? "BlattBot is working — attachments wait for the next message" : "↓ Drop images to attach"}
          </p>
        )}
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
          <ModelChip
            model={model}
            projectModel={projectModel}
            onChange={onChangeModel}
            onSetProject={onSetProjectModel}
          />
          {projectStats && projectStats.totalTurns > 0 && (
            <span
              title={`Project total across ${projectStats.totalTurns} turn${
                projectStats.totalTurns === 1 ? "" : "s"
              }`}
              className="shrink-0 rounded-full border border-rule px-2.5 py-0.5 font-mono text-[11px] text-graphite"
            >
              {projectStats.totalCostUsd > 0
                ? `Σ $${projectStats.totalCostUsd.toFixed(2)}`
                : `Σ ${projectStats.totalTurns} turn${projectStats.totalTurns === 1 ? "" : "s"}`}
            </span>
          )}
        </div>
        {pending.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-2xl flex-wrap items-center gap-2.5">
            {pending.map((p) => (
              <span key={p.key} className="relative inline-block">
                <img
                  src={p.url}
                  alt={p.name}
                  className="block h-14 w-14 rounded-lg border border-rule object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePending(p.key)}
                  disabled={busy}
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name}`}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-rule bg-ink-2 text-[11px] leading-none text-graphite transition-colors hover:border-pencil/60 hover:text-pencil disabled:opacity-40"
                >
                  ×
                </button>
              </span>
            ))}
            <span className="font-mono text-[10.5px] text-graphite">
              {pending.length} of {MAX_CHAT_IMAGES} images
            </span>
          </div>
        )}
        {shrinking && (
          <p role="status" className="mx-auto mb-2 max-w-2xl text-[11px] text-graphite">
            Resizing an image to fit the {MAX_CHAT_IMAGE_LABEL} limit…
          </p>
        )}
        {attachError && (
          <p role="status" className="mx-auto mb-2 max-w-2xl text-[11px] text-pencil">
            {attachError}
          </p>
        )}
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={CHAT_IMAGE_TYPES.join(",")}
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              // Reset so picking the same file twice still fires a change.
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || pending.length >= MAX_CHAT_IMAGES}
            aria-label="Attach images"
            title="Attach images — you can also paste or drop them here"
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-rule text-graphite transition-colors hover:border-leaf/50 hover:text-paper disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none"
              stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" />
            </svg>
          </button>
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = imageFilesFrom(e.clipboardData);
              if (files.length === 0) return;
              // A pasted screenshot must not also drop its file name as text.
              e.preventDefault();
              void addFiles(files);
            }}
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
              // Attachments alone are enough — an image-only message is valid.
              disabled={(!draft.trim() && pending.length === 0) || shrinking}
              title={shrinking ? "Resizing an attached image…" : "Send (Enter)"}
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
 * The current effective model as a mono chip; clicking opens a popover with
 * the curated suggestions plus a free-text field. Selecting saves GLOBALLY
 * (PUT /api/settings) as before; a smaller secondary action writes the typed
 * id as a project-only override instead, and an active override shows a
 * "project" hint with a clear action. Everything applies from the next turn.
 */
function ModelChip({
  model,
  projectModel,
  onChange,
  onSetProject,
}: {
  model: string;
  projectModel: string;
  onChange: (model: string) => void;
  onSetProject: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");

  function pick(id: string) {
    const next = id.trim();
    setOpen(false);
    setCustom("");
    if (next && next !== model) onChange(next);
  }

  function pickForProject(id: string) {
    const next = id.trim();
    if (!next) return;
    setOpen(false);
    setCustom("");
    onSetProject(next);
  }

  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-label="Agent model"
        title={`Agent model: ${model || "default"}${projectModel ? " (project override)" : ""} — click to change`}
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-rule px-2.5 py-0.5 font-mono text-[11px] text-graphite transition-colors hover:border-leaf/40 hover:text-paper-dim"
      >
        {shortModel(model) || "model"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full right-0 z-20 mb-1.5 w-72 rounded-lg border border-rule bg-ink-2 py-1 shadow-xl"
            onKeyDown={(e) => {
              // Keyboard escape hatch — the backdrop is mouse-only.
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          >
            <p className="px-3 pb-1 pt-1.5 text-[10.5px] uppercase tracking-wide text-graphite">
              Model — applies from the next turn
            </p>
            {MODEL_SUGGESTIONS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => pick(id)}
                title="Set as the global default model"
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
                title="Set as the global default model"
                className="rounded border border-rule px-2 py-1 text-[11px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-40"
              >
                Set
              </button>
            </div>
            {/* Project override: the typed id can apply to this project only. */}
            <div className="mx-3 mb-1.5 mt-0.5 border-t border-rule/60 pt-1.5">
              {projectModel && (
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className="min-w-0 truncate font-mono text-[10.5px] text-gold"
                    title={`This project overrides the global model with "${projectModel}"`}
                  >
                    project · {projectModel}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onSetProject("");
                    }}
                    className="ml-auto shrink-0 rounded border border-rule px-1.5 py-0.5 text-[10.5px] text-graphite transition-colors hover:border-pencil hover:text-pencil"
                  >
                    clear project override
                  </button>
                </div>
              )}
              <button
                type="button"
                disabled={!custom.trim()}
                onClick={() => pickForProject(custom)}
                title="Use the model id typed above for this project only"
                className="w-full rounded px-1 py-0.5 text-left text-[10.5px] text-graphite transition-colors hover:text-paper-dim disabled:opacity-40"
              >
                set for this project only
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The thumbnails of a user message's attachments. Each opens full size in the
 * app's own Dialog — no lightbox dependency, and the same focus/Escape
 * behaviour every other modal has.
 */
function UserImages({ projectId, images }: { projectId: string; images: ChatAttachment[] }) {
  const dialog = useDialog();
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {images.map((img, n) => {
        const src = api.chatImageUrl(projectId, img.id);
        const label = `Attached image ${n + 1} of ${images.length}`;
        return (
          <button
            key={img.id}
            type="button"
            aria-label={`${label} — view full size`}
            title="View full size"
            onClick={() =>
              void dialog.alert({
                title: label,
                wide: true,
                dismissLabel: "Close",
                body: (
                  <img
                    src={src}
                    alt={label}
                    className="mx-auto block max-h-[70vh] w-auto max-w-full rounded"
                  />
                ),
              })
            }
            className="overflow-hidden rounded-lg border border-rule transition-colors hover:border-leaf/60"
          >
            <img src={src} alt={label} className="block max-h-[140px] max-w-[140px] object-cover" />
          </button>
        );
      })}
    </div>
  );
}

function ChatBubble({
  item,
  projectId,
  onAnswerQuestion,
  onDismissQuestion,
  link,
  onLocateQuote,
  onFindInPdf,
}: {
  item: ChatItem;
  projectId: string;
  onAnswerQuestion: (questionId: string, answers: Record<string, string>) => void;
  onDismissQuestion: (questionId: string) => void;
  link: MdLinkProps;
  onLocateQuote: (text: string) => Promise<boolean>;
  /** Present only while a PDF pane is visible. */
  onFindInPdf?: (text: string) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-12 self-end rounded-xl rounded-br-sm bg-ink-3 px-4 py-2.5 text-[14px] leading-relaxed text-paper">
          {item.images && item.images.length > 0 && (
            <UserImages projectId={projectId} images={item.images} />
          )}
          <Markdown text={item.text} className="md-user" files={link.files} onOpenFile={link.onOpenFile} />
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
          <AgentText
            text={item.text}
            streaming={item.streaming}
            link={link}
            onLocateQuote={onLocateQuote}
            onFindInPdf={onFindInPdf}
          />
        </div>
      );
    case "tool":
      return <ToolChip item={item} />;
    case "question":
      return (
        <QuestionCard item={item} onAnswer={onAnswerQuestion} onDismiss={onDismissQuestion} link={link} />
      );
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
        <div role="status" className={`self-center rounded border px-3 py-1 text-center text-xs ${tone}`}>
          {item.text}
        </div>
      );
    }
    case "turn_end": {
      // The cost when known (Claude); otherwise total tokens (openai backends
      // that report usage); otherwise just the duration.
      const tokens = (item.inputTokens ?? 0) + (item.outputTokens ?? 0);
      return (
        <div className="self-center font-mono text-[10.5px] tracking-wide text-graphite/70">
          — turn complete
          {item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
          {item.costUsd != null
            ? ` · $${item.costUsd.toFixed(3)}`
            : tokens > 0
              ? ` · ${fmtTokens(tokens)} tok`
              : ""}{" "}
          —
        </div>
      );
    }
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
      {item.resultHead && (
        <div
          title={item.resultHead}
          className="mt-0.5 max-w-[420px] truncate self-start pl-4 font-mono text-[10.5px] text-graphite/80"
        >
          {item.resultHead}
        </div>
      )}
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

/**
 * A mid-turn agent question (AskUserQuestion / ask_user). While pending it
 * renders one block per question — header chip, question text, clickable
 * options (checkboxes for multi-select), and an "Other…" free-text input —
 * plus a Skip action that dismisses the whole card. A card of single-select
 * questions submits itself the moment every question has an answer; any
 * multi-select question adds an explicit Submit button. Once resolved (or
 * restored from a transcript) it collapses to muted question → answer lines.
 */
function QuestionCard({
  item,
  onAnswer,
  onDismiss,
  link,
}: {
  item: Extract<ChatItem, { kind: "question" }>;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
  onDismiss: (questionId: string) => void;
  link: MdLinkProps;
}) {
  /** Single-select: question text → chosen label (or free text). */
  const [picked, setPicked] = useState<Record<string, string>>({});
  /** Multi-select: question text → checked labels, in click order. */
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  /** Free-text "Other…" drafts per question. */
  const [other, setOther] = useState<Record<string, string>>({});

  if (item.status !== "pending") {
    return (
      <div
        data-question-card
        className="max-w-full self-start rounded-lg border border-rule bg-ink-2 px-4 py-2.5"
      >
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-graphite">
          {item.status === "answered"
            ? "answered"
            : item.status === "stale"
              ? "pending (reload to answer)"
              : "skipped"}
        </div>
        {item.questions.map((q) => (
          <div key={q.question} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
            <span className="font-mono text-[10px] uppercase tracking-wide text-graphite/80">
              {q.header}
            </span>
            <Markdown
              text={q.question}
              className="min-w-0 text-paper-dim"
              files={link.files}
              onOpenFile={link.onOpenFile}
            />
            <span className="text-graphite">→</span>
            <span className={item.status === "answered" ? "text-leaf" : "italic text-graphite"}>
              {item.status === "answered"
                ? item.answers?.[q.question] || "—"
                : item.status === "stale"
                  ? "pending"
                  : "skipped"}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const anyMulti = item.questions.some((q) => q.multiSelect);

  /** The answer a question currently holds, given a picked-map to evaluate. */
  const answerFor = (q: AgentQuestion, pickedNow: Record<string, string>): string =>
    q.multiSelect
      ? [
          ...(checked[q.question] ?? []),
          ...(other[q.question]?.trim() ? [other[q.question].trim()] : []),
        ].join(", ")
      : (pickedNow[q.question] ?? "");

  const complete = (pickedNow: Record<string, string>) =>
    item.questions.every((q) => answerFor(q, pickedNow).trim().length > 0);

  const submitWith = (pickedNow: Record<string, string>) => {
    const answers: Record<string, string> = {};
    for (const q of item.questions) answers[q.question] = answerFor(q, pickedNow);
    onAnswer(item.questionId, answers);
  };

  /** Record a single-select answer; an all-single card submits when complete. */
  const choose = (q: AgentQuestion, label: string) => {
    const next = { ...picked, [q.question]: label };
    setPicked(next);
    if (!anyMulti && complete(next)) submitWith(next);
  };

  const toggle = (q: AgentQuestion, label: string) =>
    setChecked((prev) => {
      const cur = prev[q.question] ?? [];
      return {
        ...prev,
        [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });

  return (
    <div
      data-question-card
      className="flex w-full max-w-full flex-col self-start rounded-lg border border-gold/50 bg-ink-2 px-4 py-3"
    >
      {/* The card itself is interactive, so the announcement lives on a
          visually-hidden status line (same W7 pattern as the notices):
          without it, a screen reader hears the busy indicator go quiet and
          nothing else — the turn looks hung. */}
      <span role="status" className="sr-only">
        BlattBot is asking you a question
      </span>
      <div className="mb-2 flex items-center gap-2">
        <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-gold" />
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-gold">
          BlattBot asks
        </span>
        <button
          type="button"
          onClick={() => onDismiss(item.questionId)}
          aria-label="Skip these questions"
          title="Skip — the agent proceeds with its best judgment"
          className="ml-auto rounded border border-rule px-2 py-0.5 text-[11px] text-graphite transition-colors hover:border-pencil hover:text-pencil"
        >
          Skip
        </button>
      </div>
      {/* A question with long options can otherwise dwarf the whole chat —
          cap it and let the card scroll internally instead. */}
      <div className="max-h-[26rem] min-h-0 overflow-y-auto">
        {item.questions.map((q) => (
        <div key={q.question} className="mb-3 last:mb-0">
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="shrink-0 rounded-full border border-gold/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gold">
              {q.header}
            </span>
            <Markdown
              text={q.question}
              className="min-w-0 font-serif text-[14.5px] leading-snug text-paper"
              files={link.files}
              onOpenFile={link.onOpenFile}
            />
          </div>
          <div className="flex flex-col gap-1">
            {q.options.map((o) =>
              q.multiSelect ? (
                <label
                  key={o.label}
                  title={o.description || undefined}
                  className="flex cursor-pointer items-baseline gap-2 rounded border border-rule px-2.5 py-1.5 text-[13px] text-paper-dim transition-colors hover:border-leaf/40 hover:text-paper"
                >
                  <input
                    type="checkbox"
                    checked={(checked[q.question] ?? []).includes(o.label)}
                    onChange={() => toggle(q, o.label)}
                    className="translate-y-px accent-leaf"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span>{o.label}</span>
                    {o.description && (
                      <span className="text-[11px] leading-snug text-graphite">{o.description}</span>
                    )}
                  </span>
                </label>
              ) : (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => choose(q, o.label)}
                  title={o.description || undefined}
                  className={`rounded border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    picked[q.question] === o.label
                      ? "border-leaf/60 bg-leaf/10 text-paper"
                      : "border-rule text-paper-dim hover:border-leaf/40 hover:text-paper"
                  }`}
                >
                  <span className="block">{o.label}</span>
                  {o.description && (
                    <span className="block text-[11px] leading-snug text-graphite">
                      {o.description}
                    </span>
                  )}
                </button>
              ),
            )}
            <input
              value={other[q.question] ?? ""}
              onChange={(e) =>
                setOther((prev) => ({ ...prev, [q.question]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const text = (other[q.question] ?? "").trim();
                if (q.multiSelect) {
                  // The draft joins the checked labels — Enter submits the card.
                  if (complete(picked)) submitWith(picked);
                } else if (text) {
                  choose(q, text);
                }
              }}
              placeholder="Other…"
              aria-label={`Other answer: ${q.question}`}
              className="rounded border border-rule bg-ink px-2.5 py-1.5 text-[12.5px] text-paper placeholder:text-graphite/60"
            />
          </div>
        </div>
        ))}
      </div>
      {anyMulti && (
        <button
          type="button"
          onClick={() => complete(picked) && submitWith(picked)}
          disabled={!complete(picked)}
          className="mt-1 rounded bg-leaf-deep px-3 py-1 text-[12px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-40"
        >
          Submit answers
        </button>
      )}
    </div>
  );
}
