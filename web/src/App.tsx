import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ensureAuth,
  ApproveConflictError,
  type Account,
  type AgentQuestion,
  type ChatMeta,
  type ChatTranscriptEvent,
  type CompileInfo,
  type Project,
  type ProjectDetail,
  type ProjectSettings as ProjectSettingsData,
  type Settings,
  type SyncConflict,
} from "./api";
import { tabStripKeyDown } from "./a11y";
import { DialogProvider, useDialog } from "./components/Dialog";
import Sidebar from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import SettingsModal from "./components/SettingsModal";
import ProjectSettings from "./components/ProjectSettings";
import Chat, { type ChatItem } from "./components/Chat";
import ProofPanel from "./components/ProofPanel";
import PdfPanel from "./components/PdfPanel";
import RefsPanel from "./components/RefsPanel";
import SourcePanel from "./components/SourcePanel";

type View = "dashboard" | "project";

/** The five views the two project panes can show, and their tab labels. */
const PANE_TABS = [
  ["chat", "Chat"],
  ["proof", "Proof"],
  ["source", "Source"],
  ["pdf", "PDF"],
  ["refs", "References"],
] as const;
type PaneView = (typeof PANE_TABS)[number][0];
type PaneSide = "left" | "right";
type Panes = { left: PaneView; right: PaneView };

const isPaneView = (v: string | null): v is PaneView => PANE_TABS.some(([key]) => key === v);

/**
 * Restore the per-browser pane assignment; the two panes must always differ.
 * v2 key: the default changed from chat/proof to chat/pdf — old keys are
 * ignored so everyone lands on the new default once.
 */
function loadPanes(): Panes {
  const left = localStorage.getItem("blattbot.paneLeft.v2");
  const right = localStorage.getItem("blattbot.paneRight.v2");
  if (isPaneView(left) && isPaneView(right) && left !== right) return { left, right };
  return { left: "chat", right: "pdf" };
}

const scopeKey = (id: string) => `blattbot.scope.${id}`;

/** True when `latest` is a strictly newer major.minor.patch than `current`. */
function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split(".")
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(current), parse(latest)];
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

function loadScope(id: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopeKey(id)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Rebuild the chat view from a persisted transcript. Mirrors handleEvent's
 * live mapping: user_message → user bubble (with scope), text_final → settled
 * agent bubble, tool_use + tool_result → resolved tool chip (with fileDiff),
 * question (+ answered/dismissed) → question card, turn_end → marker (or
 * interrupt notice), notice → notice. A question stays pending until its
 * answered/dismissed event or its turn's end collapses it (mirroring the live
 * handler). `pendingQuestionId` is the turn-state's still-unanswered question
 * (if any): its card restores actionable; a question with NO resolution and NO
 * turn_end that is not the pending one is in an unknown state (e.g. the
 * turn-state snapshot predates it) — it renders as stale ("reload to
 * answer"), never as skipped.
 */
function itemsFromEvents(
  events: ChatTranscriptEvent[],
  pendingQuestionId?: string | null,
): ChatItem[] {
  const items: ChatItem[] = [];
  const TONES = ["info", "warn", "error", "ok"] as const;
  for (const ev of events) {
    switch (ev?.type) {
      case "user_message": {
        const scope = Array.isArray(ev.scope)
          ? (ev.scope as unknown[]).filter((s): s is string => typeof s === "string")
          : [];
        items.push({
          kind: "user",
          text: String(ev.text ?? ""),
          ...(scope.length > 0 ? { scope } : {}),
        });
        break;
      }
      case "text_final":
        items.push({ kind: "agent", text: String(ev.text ?? ""), streaming: false });
        break;
      case "tool_use":
        items.push({
          kind: "tool",
          id: typeof ev.id === "string" ? ev.id : undefined,
          name: String(ev.name ?? ""),
          detail: String(ev.detail ?? ""),
          status: "running",
        });
        break;
      case "tool_result": {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.id !== undefined && it.id === ev.id) {
            items[i] = {
              ...it,
              status: ev.isError ? "error" : "done",
              ...(typeof ev.fileDiff === "string" && ev.fileDiff.trim()
                ? { fileDiff: ev.fileDiff }
                : {}),
            };
            break;
          }
        }
        break;
      }
      case "question":
        items.push({
          kind: "question",
          questionId: String(ev.questionId ?? ""),
          questions: Array.isArray(ev.questions) ? (ev.questions as AgentQuestion[]) : [],
          // Later events (answered/dismissed/turn_end) or the final sweep
          // below decide how it settles.
          status: "pending",
        });
        break;
      case "question_answered": {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "question" && it.questionId === ev.questionId) {
            items[i] = {
              ...it,
              status: "answered",
              answers:
                ev.answers && typeof ev.answers === "object"
                  ? (ev.answers as Record<string, string>)
                  : undefined,
            };
            break;
          }
        }
        break;
      }
      case "question_dismissed": {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "question" && it.questionId === ev.questionId) {
            items[i] = { ...it, status: "dismissed" };
            break;
          }
        }
        break;
      }
      case "turn_end":
        // The turn's end collapses any question it left unanswered — the same
        // pending → dismissed sweep the live handler applies.
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind === "question" && it.status === "pending") {
            items[i] = { ...it, status: "dismissed" };
          }
        }
        if (ev.interrupted) {
          items.push({ kind: "notice", tone: "warn", text: "Turn interrupted." });
        } else {
          items.push({
            kind: "turn_end",
            costUsd: typeof ev.costUsd === "number" ? ev.costUsd : undefined,
            durationMs: typeof ev.durationMs === "number" ? ev.durationMs : undefined,
            inputTokens: typeof ev.inputTokens === "number" ? ev.inputTokens : undefined,
            outputTokens: typeof ev.outputTokens === "number" ? ev.outputTokens : undefined,
          });
        }
        break;
      case "notice":
        items.push({
          kind: "notice",
          tone: TONES.includes(ev.tone as (typeof TONES)[number])
            ? (ev.tone as (typeof TONES)[number])
            : "info",
          text: String(ev.text ?? ""),
        });
        break;
      default:
        break;
    }
  }
  // A question still pending here has no resolution event and no turn_end:
  // the turn is (as far as the transcript knows) still blocked on it. Only
  // THE turn-state's pending question restores actionable; any other is in an
  // unknown state — mark it stale ("reload to answer"), never skipped.
  return items.map((it) =>
    it.kind === "question" && it.status === "pending" && it.questionId !== pendingQuestionId
      ? { ...it, status: "stale" as const }
      : it,
  );
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Per-project settings of the open project (style, model override, default mode).
  const [projSettings, setProjSettings] = useState<ProjectSettingsData | null>(null);
  const [projSettingsOpen, setProjSettingsOpen] = useState(false);

  const [chat, setChat] = useState<ChatItem[]>([]);
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<"idle" | "thinking" | "streaming" | "tool">("idle");
  const [diff, setDiff] = useState<string>("");
  // Approve was blocked: Overleaf changed these files while they also carry
  // local edits. The Proof view offers per-file discard or a forced overwrite.
  const [approveConflicts, setApproveConflicts] = useState<SyncConflict[] | null>(null);
  const [compile, setCompile] = useState<CompileInfo | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [pdfStamp, setPdfStamp] = useState(0);
  // "Verify on Overleaf": bumps per successful remote build (0 = none yet),
  // and which build the PDF pane currently shows.
  const [remoteStamp, setRemoteStamp] = useState(0);
  const [pdfSource, setPdfSource] = useState<"local" | "remote">("local");
  const [sourceStamp, setSourceStamp] = useState(0);
  const [panes, setPanes] = useState<Panes>(loadPanes);
  const [scope, setScope] = useState<string[]>([]);
  // A newer published BlattBot exists — the Sidebar footer links the release.
  const [update, setUpdate] = useState<{ current: string; latest: string } | null>(null);
  const [sourceReveal, setSourceReveal] = useState<{ file: string; line: number; nonce: number }>();
  // A PDF selection quoted into the chat composer; each new nonce injects once.
  const [chatQuote, setChatQuote] = useState<{ text: string; nonce: number } | null>(null);

  // Which pane each panel is mounted in. A panel stays in its last pane (as a
  // hidden wrapper) while not displayed, so tab switches within a pane never
  // remount it; only moving a panel across panes does.
  const paneOwner = useRef<Record<PaneView, PaneSide>>({
    chat: "left",
    proof: "right",
    source: "right",
    pdf: "right",
    refs: "right",
  });
  paneOwner.current[panes.left] = "left";
  paneOwner.current[panes.right] = "right";

  useEffect(() => {
    localStorage.setItem("blattbot.paneLeft.v2", panes.left);
    localStorage.setItem("blattbot.paneRight.v2", panes.right);
  }, [panes]);

  const wsRef = useRef<WebSocket | null>(null);
  // Mirrors `compiling` for use inside callbacks without stale closures.
  const compilingRef = useRef(false);
  compilingRef.current = compiling;
  // True when the working tree may have changed since the last compile — the
  // PDF tab auto-compiles only then (or when nothing was compiled yet).
  const dirtySinceCompile = useRef(false);
  // Debounce for mid-turn recompiles while the PDF pane is visible.
  const liveCompileTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refreshProjects = useCallback(async () => {
    setProjects(await api.projects());
    api.accounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  // Captured once, before the persist effect below can overwrite it with the
  // initial "dashboard" default.
  const storedViewAtLoad = useRef(localStorage.getItem("blattbot.view"));

  useEffect(() => {
    void (async () => {
      const list = await api.projects().catch(() => [] as Project[]);
      setProjects(list);
      // Restore where the user last was: the dashboard stays the dashboard;
      // otherwise reopen the last project (when it still exists).
      const last = localStorage.getItem("blattbot.selectedProject");
      if (storedViewAtLoad.current !== "dashboard" && last && list.some((p) => p.id === last)) {
        setSelectedId(last);
        setView("project");
      }
    })();
    api.accounts().then(setAccounts).catch(() => setAccounts([]));
    api.health().then((h) => setEngine(h.engine)).catch(() => setEngine(null));
    api.settings().then(setAppSettings).catch(() => setAppSettings(null));
    api
      .version()
      .then((v) => {
        if (v.latest && isNewerVersion(v.current, v.latest)) {
          setUpdate({ current: v.current, latest: v.latest });
        }
      })
      .catch(() => {});
  }, []);

  // Remember the current surface so a reload lands where the user left off.
  useEffect(() => {
    localStorage.setItem("blattbot.view", view);
  }, [view]);

  const refreshSettings = useCallback(() => {
    api.settings().then(setAppSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedId) localStorage.setItem("blattbot.selectedProject", selectedId);
  }, [selectedId]);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await api.project(id);
      setDetail(d);
      if (d.lastCompile) {
        setCompile(d.lastCompile);
        if (d.lastCompile.hasPdf) setPdfStamp((s) => s + 1);
      }
    } catch {
      setDetail(null);
    }
  }, []);

  const pushChat = useCallback((item: ChatItem) => {
    setChat((prev) => [...prev, item]);
  }, []);

  // Replace the chat with a restored transcript WITHOUT losing live question
  // state: a ws `question` that arrived while the restore was in flight must
  // survive the replace, and a card a live event already resolved must not be
  // re-armed by the (older) restore snapshot.
  const applyRestoredChat = useCallback((items: ChatItem[]) => {
    setChat((prev) => {
      const liveById = new Map<string, Extract<ChatItem, { kind: "question" }>>();
      const restoredIds = new Set<string>();
      for (const it of prev) if (it.kind === "question") liveById.set(it.questionId, it);
      for (const it of items) if (it.kind === "question") restoredIds.add(it.questionId);
      const merged = items.map((it) => {
        if (it.kind !== "question" || it.status !== "pending") return it;
        const live = liveById.get(it.questionId);
        // The live view already saw this card settle — the newer state wins.
        return live && live.status !== "pending" ? live : it;
      });
      const extras = prev.filter(
        (it) => it.kind === "question" && it.status === "pending" && !restoredIds.has(it.questionId),
      );
      return [...merged, ...extras];
    });
  }, []);

  // Titles and ordering change server-side (first message names a chat) —
  // refetch the list whenever that may have happened.
  const refreshChats = useCallback(async (id: string) => {
    try {
      const r = await api.chats(id);
      setChats(r.chats);
      setActiveChatId(r.activeChatId);
    } catch {
      /* older server / transient — keep what we have */
    }
  }, []);

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const handleEvent = useCallback(
    (ev: any) => {
      switch (ev.type) {
        case "turn_start":
          setBusy(true);
          setActivity("thinking");
          break;
        case "thinking":
          setActivity("thinking");
          break;
        case "text_delta":
          setActivity("streaming");
          setChat((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "agent" && last.streaming) {
              const next = prev.slice(0, -1);
              next.push({ ...last, text: last.text + ev.text });
              return next;
            }
            return [...prev, { kind: "agent", text: ev.text, streaming: true }];
          });
          break;
        case "text_final":
          setActivity("thinking");
          setChat((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "agent" && last.streaming) {
              const next = prev.slice(0, -1);
              next.push({ kind: "agent", text: ev.text, streaming: false });
              return next;
            }
            return [...prev, { kind: "agent", text: ev.text, streaming: false }];
          });
          break;
        case "tool_use":
          setActivity("tool");
          setChat((prev) => [
            ...prev,
            { kind: "tool", id: ev.id, name: ev.name, detail: ev.detail ?? "", status: "running" },
          ]);
          break;
        case "tool_result":
          // The model reads the result next — that's thinking time again.
          setActivity("thinking");
          setChat((prev) =>
            prev.map((item) =>
              item.kind === "tool" && item.id === ev.id
                ? {
                    ...item,
                    status: ev.isError ? "error" : "done",
                    ...(typeof ev.fileDiff === "string" && ev.fileDiff.trim()
                      ? { fileDiff: ev.fileDiff }
                      : {}),
                  }
                : item,
            ),
          );
          break;
        case "question":
          // The turn is blocked on the user now — no thinking shimmer.
          setActivity("idle");
          setChat((prev) => [
            ...prev,
            {
              kind: "question",
              questionId: String(ev.questionId ?? ""),
              questions: Array.isArray(ev.questions) ? ev.questions : [],
              status: "pending",
            },
          ]);
          break;
        case "question_answered":
          setActivity("thinking");
          setChat((prev) =>
            prev.map((item) =>
              item.kind === "question" && item.questionId === ev.questionId
                ? { ...item, status: "answered", answers: ev.answers ?? item.answers }
                : item,
            ),
          );
          break;
        case "question_dismissed":
          setActivity("thinking");
          setChat((prev) =>
            prev.map((item) =>
              item.kind === "question" && item.questionId === ev.questionId
                ? { ...item, status: "dismissed" }
                : item,
            ),
          );
          break;
        case "turn_end":
          setBusy(false);
          setActivity("idle");
          dirtySinceCompile.current = true;
          setSourceStamp((s) => s + 1);
          // The server compiles after every turn anyway — drop pending mid-turn ones.
          clearTimeout(liveCompileTimer.current);
          if (selectedId) void refreshChats(selectedId);
          setChat((prev) => {
            // Close any bubble left streaming (e.g. after an interrupt) and
            // collapse question cards the turn's end left unanswered.
            const closed = prev.map((item) =>
              item.kind === "agent" && item.streaming
                ? { ...item, streaming: false }
                : item.kind === "question" && item.status === "pending"
                  ? { ...item, status: "dismissed" as const }
                  : item,
            );
            if (ev.interrupted) {
              return [...closed, { kind: "notice", tone: "warn", text: "Turn interrupted." }];
            }
            return [
              ...closed,
              {
                kind: "turn_end",
                costUsd: ev.costUsd,
                durationMs: ev.durationMs,
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
              },
            ];
          });
          if (selectedId) void refreshDetail(selectedId);
          break;
        case "diff":
          setDiff(ev.diff ?? "");
          if (ev.diff?.trim()) {
            dirtySinceCompile.current = true;
            // No pane is switched automatically — the Proof tab's pending dot
            // signals changes, and a visible PDF refreshes itself instead.
            if (ev.live) {
              // The agent just edited a file: keep a visible PDF fresh. Debounced
              // so bursts of edits compile once; compilingRef stops overlap.
              const p = panesRef.current;
              if (p.left === "pdf" || p.right === "pdf") {
                clearTimeout(liveCompileTimer.current);
                liveCompileTimer.current = setTimeout(() => {
                  if (!compilingRef.current) void startCompileRef.current();
                }, 1_500);
              }
            }
          }
          break;
        case "compile_start":
          setCompiling(true);
          break;
        case "compile": {
          const { type, ...info } = ev;
          setCompiling(false);
          dirtySinceCompile.current = false;
          setCompile(info as CompileInfo);
          if ((info as CompileInfo).hasPdf) setPdfStamp((s) => s + 1);
          break;
        }
        case "sync_warning":
          pushChat({ kind: "notice", tone: "warn", text: `Sync: ${ev.message}` });
          break;
        case "error":
          pushChat({ kind: "notice", tone: "error", text: ev.message });
          break;
        case "approved":
          setDiff("");
          setApproveConflicts(null);
          setSourceStamp((s) => s + 1);
          pushChat({
            kind: "notice",
            tone: "ok",
            text:
              selectedRef.current?.kind === "local"
                ? "Committed locally."
                : ev.pushed
                  ? "Changes pushed to Overleaf."
                  : "Nothing to push.",
          });
          // Safety-relevant push warnings must reach the user: the OT-fallback
          // notice (comments/tracked changes on a doc may not survive), the
          // forced-overwrite backup location, files to delete manually, …
          if (Array.isArray(ev.warnings) && ev.warnings.length > 0) {
            pushChat({ kind: "notice", tone: "warn", text: ev.warnings.join("\n") });
          }
          // The push also absorbed collaborator edits to files we hadn't
          // touched — the tree changed beyond what was reviewed.
          if (Array.isArray(ev.absorbedRemote) && ev.absorbedRemote.length > 0) {
            dirtySinceCompile.current = true;
            pushChat({
              kind: "notice",
              tone: "info",
              text: `Also picked up Overleaf changes to: ${ev.absorbedRemote.join(", ")}`,
            });
          }
          break;
        case "rejected":
          setDiff("");
          setApproveConflicts(null);
          // The working tree just reverted — the last PDF no longer matches it.
          dirtySinceCompile.current = true;
          setSourceStamp((s) => s + 1);
          pushChat({ kind: "notice", tone: "info", text: "Changes discarded." });
          break;
        default:
          break;
      }
    },
    [pushChat, refreshDetail, refreshChats, selectedId],
  );

  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  // (Re)connect the websocket when the selected project changes.
  useEffect(() => {
    if (!selectedId) return;
    setChat([]);
    setChats([]);
    setActiveChatId(null);
    setDiff("");
    setApproveConflicts(null);
    setCompile(null);
    setCompiling(false);
    setRemoteStamp(0);
    setPdfSource("local");
    compilingRef.current = false;
    dirtySinceCompile.current = false;
    clearTimeout(liveCompileTimer.current);
    setBusy(false);
    setActivity("idle");
    setScope(loadScope(selectedId));
    setProjSettings(null);
    setProjSettingsOpen(false);
    void refreshDetail(selectedId);
    api
      .diff(selectedId)
      .then((d) => {
        setDiff(d.diff);
        // Pending changes right at open: we can't know whether the server's
        // last compile already includes them — treat the preview as stale so
        // the PDF tab and the rendered diff recompile before trusting it.
        if (d.diff.trim()) dirtySinceCompile.current = true;
      })
      .catch(() => {});
    api.projectSettings(selectedId).then(setProjSettings).catch(() => setProjSettings(null));

    // Stale-async guard for the effect's fetches (the same pattern as the
    // projectIdRef in VerifyOnOverleaf): once the user switches projects, a
    // slow response for the OLD project must not write its chats, transcript,
    // or — worst — a sticky busy=true into the NEW project's view.
    let cancelled = false;

    /** The restored chat: transcript items + the turn state's pending question. */
    const restoredItems = (events: ChatTranscriptEvent[], d: ProjectDetail): ChatItem[] => {
      const pending = d.turnActive ? d.pendingQuestion : null;
      const items = itemsFromEvents(events, pending?.questionId ?? null);
      // The `question` event's persistence is best-effort — synthesize the
      // actionable card from the turn state when the transcript lacks it.
      if (
        pending &&
        !items.some((it) => it.kind === "question" && it.questionId === pending.questionId)
      ) {
        items.push({
          kind: "question",
          questionId: pending.questionId,
          questions: pending.questions,
          status: "pending",
        });
      }
      return items;
    };

    // Restore the active chat's persisted transcript (survives refresh/switch).
    // Ordered: transcript FIRST, then the turn state — a question registered
    // while the transcript request was in flight only exists in the LATER
    // project snapshot, so fetching that one last can never miss the pending
    // question (which would restore a dead card while the turn blocks on it).
    void (async () => {
      try {
        const r = await api.chats(selectedId);
        if (cancelled) return;
        setChats(r.chats);
        setActiveChatId(r.activeChatId);
        const { events } = await api.chatTranscript(selectedId, r.activeChatId);
        const d = await api.project(selectedId);
        if (cancelled) return;
        // A reload mid-turn: reflect the running turn (composer locks, Stop
        // shows) and re-arm the still-pending question card, if any.
        if (d.turnActive) setBusy(true);
        applyRestoredChat(restoredItems(events, d));
      } catch {
        /* older server or fetch hiccup — start with an empty chat */
      }
    })();

    // The upgrade must carry the auth cookie — make sure bootstrap ran first.
    // The socket RECONNECTS after drops (dev-server restarts, sleep, crashes):
    // without this, a turn started after a silent drop streams into the void —
    // no tool chips, no busy state, no Stop button until a manual refresh.
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let everConnected = false;

    const connect = () => {
      if (cancelled) return;
      void ensureAuth()
        .catch(() => {})
        .then(() => {
          if (cancelled) return;
          const proto = location.protocol === "https:" ? "wss" : "ws";
          ws = new WebSocket(`${proto}://${location.host}/api/ws?project=${encodeURIComponent(selectedId)}`);
          ws.onopen = () => {
            if (cancelled) return;
            if (everConnected) {
              // Back after a drop: refresh what only ws events would have
              // updated (the effect body already fetched these on open).
              void refreshDetail(selectedId);
              api
                .diff(selectedId)
                .then((d) => {
                  if (!cancelled) setDiff(d.diff);
                })
                .catch(() => {});
            }
            everConnected = true;
            // Backfill the transcript + turn state on EVERY open — the first
            // one included: an event broadcast before the socket was listening
            // (e.g. a question registered while the initial restore was in
            // flight) is only recoverable from a snapshot taken after the
            // socket opened. Same ordering and stale-guards as the restore
            // above; applyRestoredChat keeps the two from clobbering a live
            // pending question card.
            void (async () => {
              try {
                const r = await api.chats(selectedId);
                if (cancelled) return;
                const { events } = await api.chatTranscript(selectedId, r.activeChatId);
                const d = await api.project(selectedId);
                if (cancelled) return;
                setBusy(d.turnActive);
                if (!d.turnActive) setActivity("idle");
                applyRestoredChat(restoredItems(events, d));
              } catch {
                /* keep the current view */
              }
            })();
          };
          ws.onmessage = (msg) => {
            try {
              handleEventRef.current(JSON.parse(msg.data));
            } catch {
              /* malformed frame */
            }
          };
          ws.onclose = () => {
            if (cancelled) return;
            wsRef.current = null;
            retryTimer = setTimeout(connect, 1_500);
          };
          wsRef.current = ws;
        });
    };
    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [selectedId, refreshDetail, applyRestoredChat]);

  const changeScope = useCallback(
    (next: string[]) => {
      setScope(next);
      if (selectedId) localStorage.setItem(scopeKey(selectedId), JSON.stringify(next));
    },
    [selectedId],
  );

  // Drop scope entries whose files disappeared (agent deletes, syncs, …).
  useEffect(() => {
    if (!detail) return;
    setScope((prev) => {
      const next = prev.filter((f) => detail.files.includes(f));
      if (next.length !== prev.length && selectedId) {
        localStorage.setItem(scopeKey(selectedId), JSON.stringify(next));
      }
      return next.length === prev.length ? prev : next;
    });
  }, [detail, selectedId]);

  const openProject = useCallback((id: string) => {
    setSelectedId(id);
    setView("project");
  }, []);

  const goDashboard = useCallback(() => {
    setView("dashboard");
    void refreshProjects();
  }, [refreshProjects]);

  const send = useCallback(
    async (message: string, mode: string) => {
      if (!selectedId) return;
      const files = scope.length > 0 ? [...scope] : undefined;
      pushChat({ kind: "user", text: message, scope: files });
      try {
        await api.chat(selectedId, message, mode, files);
        // The server accepted the turn — reflect it immediately instead of
        // waiting for the websocket's turn_start (which a dropped socket
        // would never deliver, leaving no Stop button and no activity).
        setBusy(true);
        setActivity("thinking");
        // The first message titles a fresh chat server-side.
        void refreshChats(selectedId);
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, scope, pushChat, refreshChats],
  );

  const interrupt = useCallback(async () => {
    if (selectedId) await api.interrupt(selectedId).catch(() => {});
  }, [selectedId]);

  // Answer a mid-turn question. The card collapses optimistically; the server
  // echoes a question_answered broadcast (idempotent) and the turn resumes.
  // A failed POST rolls the card back to actionable — the on-screen record
  // must never claim an answer the agent did not receive.
  const answerQuestion = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
      if (!selectedId) return;
      const startedFor = selectedId;
      setChat((prev) =>
        prev.map((item) =>
          item.kind === "question" && item.questionId === questionId
            ? { ...item, status: "answered" as const, answers }
            : item,
        ),
      );
      setActivity("thinking");
      try {
        await api.answerQuestion(selectedId, questionId, answers);
      } catch (err: any) {
        if (selectedRef.current?.id !== startedFor) return;
        setChat((prev) =>
          prev.map((item) =>
            item.kind === "question" && item.questionId === questionId
              ? { ...item, status: "pending" as const, answers: undefined }
              : item,
          ),
        );
        setActivity("idle");
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

  const dismissQuestion = useCallback(
    async (questionId: string) => {
      if (!selectedId) return;
      const startedFor = selectedId;
      setChat((prev) =>
        prev.map((item) =>
          item.kind === "question" && item.questionId === questionId
            ? { ...item, status: "dismissed" as const }
            : item,
        ),
      );
      setActivity("thinking");
      try {
        await api.dismissQuestion(selectedId, questionId);
      } catch (err: any) {
        if (selectedRef.current?.id !== startedFor) return;
        setChat((prev) =>
          prev.map((item) =>
            item.kind === "question" && item.questionId === questionId
              ? { ...item, status: "pending" as const }
              : item,
          ),
        );
        setActivity("idle");
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

  const selectChat = useCallback(
    async (chatId: string) => {
      if (!selectedId || chatId === activeChatId) return;
      try {
        await api.activateChat(selectedId, chatId);
        setActiveChatId(chatId);
        const { events } = await api.chatTranscript(selectedId, chatId);
        setChat(itemsFromEvents(events));
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, activeChatId, pushChat],
  );

  const newChat = useCallback(async () => {
    if (!selectedId) return;
    try {
      const created = await api.createChat(selectedId);
      setActiveChatId(created.id);
      setChats((prev) => [created, ...prev]);
      setChat([]);
    } catch (err: any) {
      pushChat({ kind: "notice", tone: "error", text: err.message });
    }
  }, [selectedId, pushChat]);

  const removeChat = useCallback(
    async (chatId: string) => {
      if (!selectedId) return;
      try {
        const r = await api.deleteChat(selectedId, chatId);
        setChats(r.chats);
        setActiveChatId(r.activeChatId);
        // Deleting the active chat lands us on another one — load its transcript.
        if (chatId === activeChatId) {
          const { events } = await api.chatTranscript(selectedId, r.activeChatId);
          setChat(itemsFromEvents(events));
        }
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, activeChatId, pushChat],
  );

  const changeModel = useCallback(
    async (model: string) => {
      try {
        setAppSettings(await api.saveSettings({ model }));
        // A global change shifts the project's effective model too (unless overridden).
        if (selectedId) api.projectSettings(selectedId).then(setProjSettings).catch(() => {});
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

  /** Write (or clear, with "") the project's model override. */
  const changeProjectModel = useCallback(
    async (model: string) => {
      if (!selectedId) return;
      try {
        setProjSettings(await api.saveProjectSettings(selectedId, { model }));
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

  const approve = useCallback(
    async (message: string, force = false) => {
      if (!selectedId) return;
      try {
        await api.approve(selectedId, message, force);
        setApproveConflicts(null);
      } catch (err: any) {
        if (err instanceof ApproveConflictError) {
          // Blocked, nothing committed or pushed — the Proof view shows the
          // conflict banner with per-file discard and a forced overwrite.
          setApproveConflicts(err.conflicts);
          return;
        }
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

  // Conflict banner: drop the local edits to the conflicted files, so the
  // remote versions merge in on the next sync/approve.
  const discardConflicts = useCallback(
    async (paths: string[]) => {
      if (!selectedId) return;
      for (const path of paths) {
        try {
          await api.rejectFile(selectedId, path);
        } catch {
          /* may already be clean — keep going */
        }
      }
      try {
        const d = await api.diff(selectedId);
        setDiff(d.diff);
      } catch {
        /* keep the current view */
      }
      dirtySinceCompile.current = true;
      setSourceStamp((s) => s + 1);
      setApproveConflicts(null);
    },
    [selectedId],
  );

  // Manual pull of incoming Overleaf/git changes.
  const [syncing, setSyncing] = useState(false);
  const syncNow = useCallback(async () => {
    if (!selectedId || syncing) return;
    setSyncing(true);
    try {
      const r = await api.sync(selectedId);
      const changed = r.changed ?? Boolean(r.output);
      // Drift = Overleaf moved on for files that also have local edits — warn.
      pushChat({
        kind: "notice",
        tone: r.drift?.length ? "warn" : "info",
        text: r.output || "Already up to date.",
      });
      if (changed) {
        setSourceStamp((s) => s + 1);
        dirtySinceCompile.current = true;
        api.diff(selectedId).then((d) => setDiff(d.diff)).catch(() => {});
        void refreshDetail(selectedId);
        const p = panesRef.current;
        if ((p.left === "pdf" || p.right === "pdf") && !compilingRef.current) {
          void startCompileRef.current();
        }
      }
    } catch (err: any) {
      pushChat({ kind: "notice", tone: "error", text: err.message });
    } finally {
      setSyncing(false);
    }
  }, [selectedId, syncing, pushChat, refreshDetail]);

  const reject = useCallback(async () => {
    if (!selectedId) return;
    try {
      await api.reject(selectedId);
    } catch (err: any) {
      pushChat({ kind: "notice", tone: "error", text: err.message });
    }
  }, [selectedId, pushChat]);

  const rejectFile = useCallback(
    async (path: string) => {
      if (!selectedId) return;
      try {
        const r = await api.rejectFile(selectedId, path);
        // The working tree just changed under the last compile/source view.
        dirtySinceCompile.current = true;
        setSourceStamp((s) => s + 1);
        setDiff(r.diff);
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

  const rejectHunk = useCallback(
    async (patch: string) => {
      if (!selectedId) return;
      try {
        const r = await api.rejectHunk(selectedId, patch);
        dirtySinceCompile.current = true;
        setSourceStamp((s) => s + 1);
        setDiff(r.diff);
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

  // A manual save from the Source tab changed the working tree — the next
  // visit to the PDF tab should recompile.
  const handleManualSaveDiff = useCallback((d: string) => {
    dirtySinceCompile.current = true;
    setDiff(d);
  }, []);

  // After a source save: if the PDF is on screen, refresh it immediately.
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const handleSourceSaved = useCallback(() => {
    const p = panesRef.current;
    if ((p.left === "pdf" || p.right === "pdf") && !compilingRef.current) {
      void startCompileRef.current();
    }
  }, []);

  // "Quote in chat" from the PDF: bump the nonce so Chat appends exactly once.
  const quoteToChat = useCallback((text: string) => {
    setChatQuote((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Jump to a file/line in the Source view (cite-jump et al.). Targets the
  // pane already showing the source, else switches the right pane over to it.
  const revealInSource = useCallback((file: string, line: number) => {
    setPanes((prev) => {
      if (prev.left === "source" || prev.right === "source") return prev;
      return { ...prev, right: "source" };
    });
    setSourceReveal((r) => ({ file, line, nonce: (r?.nonce ?? 0) + 1 }));
  }, []);

  const startCompileRef = useRef<() => Promise<void>>(async () => {});
  const startCompile = useCallback(async () => {
    if (!selectedId || compilingRef.current) return;
    compilingRef.current = true;
    setCompiling(true);
    try {
      await api.compile(selectedId);
      // The "compile" websocket event clears `compiling` and the dirty flag.
    } catch (err: any) {
      compilingRef.current = false;
      setCompiling(false);
      pushChat({ kind: "notice", tone: "error", text: err.message });
    }
  }, [selectedId, pushChat]);
  startCompileRef.current = startCompile;

  // The rendered diff needs an up-to-date CURRENT build — same rule as opening
  // the PDF tab: compile only when the preview is missing or stale.
  const ensureFreshCompile = useCallback(() => {
    if (!busy && !compilingRef.current && (compile === null || dirtySinceCompile.current)) {
      void startCompile();
    }
  }, [busy, compile, startCompile]);

  // A "Verify on Overleaf" build just landed — switch the viewer to it.
  const remoteVerified = useCallback(() => {
    setRemoteStamp((s) => s + 1);
    setPdfSource("remote");
  }, []);

  // Recompile is global: show the PDF wherever it already is, else in the
  // pane whose strip was clicked, and kick off a compile.
  const runCompile = useCallback(
    (side: PaneSide) => {
      setPanes((prev) => {
        if (prev.left === "pdf" || prev.right === "pdf") return prev;
        return { ...prev, [side]: "pdf" };
      });
      void startCompile();
    },
    [startCompile],
  );

  const selectView = useCallback(
    (side: PaneSide, view: PaneView) => {
      setPanes((prev) => {
        if (prev[side] === view) return prev;
        // The two panes always show different views — picking the other
        // pane's view swaps the two.
        if (prev[side === "left" ? "right" : "left"] === view) {
          return { left: prev.right, right: prev.left };
        }
        return { ...prev, [side]: view };
      });
      // Showing the PDF compiles automatically when the preview is missing
      // or stale — never while a compile or agent turn is already running.
      if (view === "pdf" && !busy && !compilingRef.current && (compile === null || dirtySinceCompile.current)) {
        void startCompile();
      }
    },
    [busy, compile, startCompile],
  );

  // The default layout opens with the PDF pane visible — make sure a PDF
  // exists: compile once per project open when the server has no cached one.
  const openCompiledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || !detail || detail.id !== selectedId) return;
    if (openCompiledFor.current === selectedId) return;
    openCompiledFor.current = selectedId;
    if (
      (panes.left === "pdf" || panes.right === "pdf") &&
      compile === null &&
      !compilingRef.current &&
      !busy
    ) {
      void startCompile();
    }
  }, [selectedId, detail, panes, compile, busy, startCompile]);

  // --- Resizable right panel ---
  const clampPanel = (w: number) =>
    Math.min(Math.max(w, 320), Math.max(360, window.innerWidth - 520));
  const [panelW, setPanelW] = useState(() => {
    const saved = Number(localStorage.getItem("blattbot.panelWidth"));
    return clampPanel(Number.isFinite(saved) && saved > 0 ? saved : Math.round(window.innerWidth * 0.44));
  });
  const dragging = useRef(false);

  const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  }, []);
  const onDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    setPanelW(clampPanel(window.innerWidth - e.clientX));
  }, []);
  const endDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setPanelW((w) => {
      localStorage.setItem("blattbot.panelWidth", String(w));
      return w;
    });
  }, []);
  /** Keyboard resize: ~2% of the window per press, persisted like a drag-end. */
  const keyResize = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = Math.max(16, Math.round(window.innerWidth * 0.02));
    setPanelW((w) => {
      const next = clampPanel(e.key === "ArrowLeft" ? w + step : w - step);
      localStorage.setItem("blattbot.panelWidth", String(next));
      return next;
    });
  }, []);

  const inProject = view === "project" && selected !== null;

  /** One panel instance per view — rendered into whichever pane owns it. */
  const renderPanel = (key: PaneView) => {
    switch (key) {
      case "chat":
        return (
          <Chat
            items={chat}
            busy={busy}
            activity={activity}
            onSend={send}
            onInterrupt={interrupt}
            onAnswerQuestion={answerQuestion}
            onDismissQuestion={dismissQuestion}
            projectId={selectedId!}
            projectName={selected!.name}
            defaultMode={projSettings?.defaultMode ?? ""}
            scope={scope}
            onClearScope={() => changeScope([])}
            chats={chats}
            activeChatId={activeChatId}
            onSelectChat={selectChat}
            onNewChat={newChat}
            onDeleteChat={removeChat}
            model={
              // The server-resolved per-project model (override → global) is
              // authoritative; the global setting fills in until it loads.
              projSettings?.resolvedModel ?? appSettings?.resolvedModel ?? ""
            }
            projectModel={projSettings?.model ?? ""}
            onChangeModel={changeModel}
            onSetProjectModel={changeProjectModel}
            projectStats={detail?.stats ?? null}
            quote={chatQuote}
          />
        );
      case "proof":
        return (
          <ProofPanel
            diff={diff}
            busy={busy}
            conflicts={approveConflicts}
            projectId={selectedId!}
            compile={compile}
            compiling={compiling}
            pdfStamp={pdfStamp}
            onEnsureCurrentPdf={ensureFreshCompile}
            onApprove={approve}
            onReject={reject}
            onRejectFile={rejectFile}
            onRejectHunk={rejectHunk}
            onDiscardConflicts={discardConflicts}
          />
        );
      case "source":
        return (
          <SourcePanel
            projectId={selectedId!}
            files={detail?.files ?? []}
            mainTex={selected!.mainTex}
            stamp={sourceStamp}
            busy={busy}
            onDiff={handleManualSaveDiff}
            onSaved={handleSourceSaved}
            reveal={sourceReveal}
          />
        );
      case "pdf":
        return (
          <PdfPanel
            projectId={selectedId!}
            compile={compile}
            stamp={pdfStamp}
            compiling={compiling}
            remoteStamp={remoteStamp}
            source={pdfSource}
            onSelectSource={setPdfSource}
            onJumpToSource={revealInSource}
            chatVisible={panes.left === "chat" || panes.right === "chat"}
            onQuoteToChat={quoteToChat}
          />
        );
      case "refs":
        return (
          <RefsPanel
            projectId={selectedId!}
            stamp={chat.length}
            busy={busy}
            onJump={revealInSource}
            onDiff={handleManualSaveDiff}
          />
        );
    }
  };

  /** A pane: its compact tab strip plus the panels it currently owns. */
  const renderPane = (side: PaneSide) => {
    const active = panes[side];
    return (
      <>
        <nav
          role="tablist"
          aria-label={side === "left" ? "Left pane view" : "Right pane view"}
          className="flex flex-wrap items-center gap-1 border-b border-rule px-3 pt-2"
        >
          {PANE_TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={active === key}
              aria-controls={`pane-panel-${key}`}
              tabIndex={active === key ? 0 : -1}
              onClick={() => selectView(side, key)}
              onKeyDown={tabStripKeyDown}
              className={`rounded-t px-2.5 py-1.5 text-[13px] transition-colors ${
                active === key
                  ? "border border-b-0 border-rule bg-ink-2 text-paper"
                  : "text-graphite hover:text-paper-dim"
              }`}
            >
              {label}
              {key === "proof" && diff.trim() && (
                <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-gold align-middle" />
              )}
              {key === "pdf" && compiling && (
                <span className="working-dot ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-gold align-middle" />
              )}
            </button>
          ))}
          {active === "pdf" && (
            <span className="ml-auto flex items-center gap-1.5">
              {selected!.kind === "overleaf" && (
                <VerifyOnOverleaf
                  projectId={selectedId!}
                  onVerified={remoteVerified}
                  onError={(text) => pushChat({ kind: "notice", tone: "error", text })}
                />
              )}
              <button
                onClick={() => runCompile(side)}
                title={`Local preflight${engine ? ` (${engine})` : ""}: checks your edits compile locally; Overleaf's own TeX Live may differ`}
                className="mb-1 rounded border border-rule px-2.5 py-1 text-xs text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
              >
                Recompile
              </button>
            </span>
          )}
        </nav>
        <div className="min-h-0 flex-1">
          {/* Panels stay mounted (hidden) in their owning pane so drafts,
              scroll, and the loaded PDF survive tab switches. */}
          {PANE_TABS.map(([key, label]) =>
            paneOwner.current[key] === side ? (
              <div
                key={key}
                id={`pane-panel-${key}`}
                role="tabpanel"
                aria-label={label}
                className={active === key ? "h-full" : "hidden"}
              >
                {renderPanel(key)}
              </div>
            ) : null,
          )}
        </div>
      </>
    );
  };

  return (
    <DialogProvider>
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-rule bg-ink-2 px-4">
        <button
          onClick={goDashboard}
          aria-label="Back to the project dashboard"
          title="Back to the project dashboard"
          className="flex cursor-pointer select-none items-center gap-2"
        >
          <img src="/logo.svg" alt="" aria-hidden="true" className="h-[18px] w-auto" />
          <h1 className="tex-logo text-[19px] text-paper">
            <span className="lt">B</span>
            <span className="lt">l</span>
            <span className="lt">
              <span className="up">a</span>
            </span>
            <span className="lt">t</span>
            <span className="lt">t</span>
            <span className="lt">B</span>
            <span className="lt">
              <span className="down">o</span>
            </span>
            <span className="lt">t</span>
          </h1>
        </button>
        {inProject && (
          <span className="truncate font-serif text-[15px] italic text-paper-dim">
            {selected!.name}
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-xs text-graphite">
          {busy && (
            <span className="flex items-center gap-1.5 text-leaf">
              <span className="working-dot inline-block h-2 w-2 rounded-full bg-leaf" />
              {activity === "streaming" ? "writing" : activity === "tool" ? "using tools" : "thinking"}
            </span>
          )}
          <span className="font-mono">{engine ? `engine · ${engine}` : "no TeX engine"}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {!inProject ? (
          <Dashboard
            projects={projects}
            accounts={accounts}
            onOpen={openProject}
            onChanged={refreshProjects}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <>
            <Sidebar
              projects={projects}
              project={selected!}
              files={detail?.files ?? []}
              scope={scope}
              onScopeChange={changeScope}
              onSelect={openProject}
              onDashboard={goDashboard}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenProjectSettings={() => setProjSettingsOpen(true)}
              onSync={selected!.kind === "local" ? undefined : syncNow}
              syncing={syncing}
              update={update}
            />

            <main
              data-pane="left"
              className="booktabs flex min-w-0 flex-1 flex-col border-r border-rule bg-ink"
            >
              {renderPane("left")}
            </main>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panel"
              aria-valuenow={Math.round(panelW)}
              aria-valuemin={320}
              aria-valuemax={Math.max(360, window.innerWidth - 520)}
              tabIndex={0}
              onKeyDown={keyResize}
              onPointerDown={startDrag}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-leaf/50 active:bg-leaf/70"
            />
            <aside
              data-pane="right"
              style={{ width: panelW }}
              className="booktabs flex min-w-[320px] shrink-0 flex-col bg-ink"
            >
              {renderPane("right")}
            </aside>
          </>
        )}
      </div>

      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            // The modal may have changed the model — keep the composer chip honest.
            refreshSettings();
          }}
          onAccountsChanged={refreshProjects}
          projectId={inProject ? selectedId : null}
          projectName={inProject ? selected!.name : undefined}
        />
      )}

      {projSettingsOpen && selected && (
        <ProjectSettings
          project={selected}
          onClose={() => setProjSettingsOpen(false)}
          onSaved={setProjSettings}
        />
      )}
    </div>
    </DialogProvider>
  );
}

/**
 * Tab-strip action for Overleaf projects: run Overleaf's own compiler on the
 * project's CURRENT REMOTE state (approved & pushed — not unpushed local
 * edits). Success switches the PDF pane to the remote build; a failed build
 * shows the remote compiler's log in a dialog.
 */
function VerifyOnOverleaf({
  projectId,
  onVerified,
  onError,
}: {
  projectId: string;
  onVerified: () => void;
  onError: (message: string) => void;
}) {
  const dialog = useDialog();
  const [running, setRunning] = useState(false);
  // Stale-async guard: the instance survives project switches (same tree
  // position), so a verify resolving after a switch must not flip the NEW
  // project's PDF pane to a remote build that doesn't exist for it.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  useEffect(() => setRunning(false), [projectId]);

  const run = async () => {
    if (running) return;
    const startedFor = projectId;
    setRunning(true);
    try {
      const r = await api.remoteCompile(projectId);
      if (projectIdRef.current !== startedFor) return;
      if (r.pdf) {
        onVerified();
      } else {
        void dialog.alert({
          title: "Overleaf build failed",
          body: (
            <div>
              <p className="mb-2">
                This is the output of Overleaf's own compiler, run on the project as it
                currently is on Overleaf.
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-rule bg-ink px-2.5 py-2 font-mono text-[11px] leading-relaxed text-paper-dim">
                {r.logTail?.trim() || `status: ${r.status}`}
              </pre>
            </div>
          ),
        });
      }
    } catch (err: any) {
      if (projectIdRef.current !== startedFor) return;
      onError(err.message);
    } finally {
      if (projectIdRef.current === startedFor) setRunning(false);
    }
  };

  return (
    <button
      onClick={() => void run()}
      disabled={running}
      title="Compiles the project as it currently is on Overleaf (approved & pushed changes) with Overleaf's own compiler"
      className="mb-1 rounded border border-rule px-2.5 py-1 text-xs text-paper-dim transition-colors hover:border-gold hover:text-gold disabled:cursor-default disabled:opacity-60"
    >
      {running && (
        <span className="working-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-gold align-middle" />
      )}
      {running ? "Verifying…" : "Verify on Overleaf"}
    </button>
  );
}
