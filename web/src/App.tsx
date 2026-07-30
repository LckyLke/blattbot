import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ensureAuth,
  type Account,
  type ChatMeta,
  type ChatTranscriptEvent,
  type CompileInfo,
  type Project,
  type ProjectDetail,
  type Settings,
} from "./api";
import { DialogProvider } from "./components/Dialog";
import Sidebar from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import SettingsModal from "./components/SettingsModal";
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
 * turn_end → marker (or interrupt notice), notice → notice.
 */
function itemsFromEvents(events: ChatTranscriptEvent[]): ChatItem[] {
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
      case "turn_end":
        if (ev.interrupted) {
          items.push({ kind: "notice", tone: "warn", text: "Turn interrupted." });
        } else {
          items.push({
            kind: "turn_end",
            costUsd: typeof ev.costUsd === "number" ? ev.costUsd : undefined,
            durationMs: typeof ev.durationMs === "number" ? ev.durationMs : undefined,
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
  return items;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [chat, setChat] = useState<ChatItem[]>([]);
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<"idle" | "thinking" | "streaming" | "tool">("idle");
  const [diff, setDiff] = useState<string>("");
  const [compile, setCompile] = useState<CompileInfo | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [pdfStamp, setPdfStamp] = useState(0);
  const [sourceStamp, setSourceStamp] = useState(0);
  const [panes, setPanes] = useState<Panes>(loadPanes);
  const [scope, setScope] = useState<string[]>([]);
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
        case "turn_end":
          setBusy(false);
          setActivity("idle");
          dirtySinceCompile.current = true;
          setSourceStamp((s) => s + 1);
          // The server compiles after every turn anyway — drop pending mid-turn ones.
          clearTimeout(liveCompileTimer.current);
          if (selectedId) void refreshChats(selectedId);
          setChat((prev) => {
            // Close any bubble left streaming (e.g. after an interrupt).
            const closed = prev.map((item) =>
              item.kind === "agent" && item.streaming ? { ...item, streaming: false } : item,
            );
            if (ev.interrupted) {
              return [...closed, { kind: "notice", tone: "warn", text: "Turn interrupted." }];
            }
            return [...closed, { kind: "turn_end", costUsd: ev.costUsd, durationMs: ev.durationMs }];
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
          break;
        case "rejected":
          setDiff("");
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
    setCompile(null);
    setCompiling(false);
    compilingRef.current = false;
    dirtySinceCompile.current = false;
    clearTimeout(liveCompileTimer.current);
    setBusy(false);
    setActivity("idle");
    setScope(loadScope(selectedId));
    void refreshDetail(selectedId);
    api.diff(selectedId).then((d) => setDiff(d.diff)).catch(() => {});

    // Restore the active chat's persisted transcript (survives refresh/switch).
    void (async () => {
      try {
        const r = await api.chats(selectedId);
        setChats(r.chats);
        setActiveChatId(r.activeChatId);
        const { events } = await api.chatTranscript(selectedId, r.activeChatId);
        setChat(itemsFromEvents(events));
      } catch {
        /* older server or fetch hiccup — start with an empty chat */
      }
    })();

    // The upgrade must carry the auth cookie — make sure bootstrap ran first.
    let ws: WebSocket | null = null;
    let cancelled = false;
    void ensureAuth()
      .catch(() => {})
      .then(() => {
        if (cancelled) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/api/ws?project=${encodeURIComponent(selectedId)}`);
        ws.onmessage = (msg) => {
          try {
            handleEventRef.current(JSON.parse(msg.data));
          } catch {
            /* malformed frame */
          }
        };
        wsRef.current = ws;
      });
    return () => {
      cancelled = true;
      ws?.close();
      wsRef.current = null;
    };
  }, [selectedId, refreshDetail]);

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
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [pushChat],
  );

  const approve = useCallback(
    async (message: string) => {
      if (!selectedId) return;
      try {
        await api.approve(selectedId, message);
      } catch (err: any) {
        pushChat({ kind: "notice", tone: "error", text: err.message });
      }
    },
    [selectedId, pushChat],
  );

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
            projectName={selected!.name}
            scope={scope}
            onClearScope={() => changeScope([])}
            chats={chats}
            activeChatId={activeChatId}
            onSelectChat={selectChat}
            onNewChat={newChat}
            onDeleteChat={removeChat}
            model={appSettings?.resolvedModel ?? ""}
            onChangeModel={changeModel}
            quote={chatQuote}
          />
        );
      case "proof":
        return (
          <ProofPanel
            diff={diff}
            busy={busy}
            onApprove={approve}
            onReject={reject}
            onRejectFile={rejectFile}
            onRejectHunk={rejectHunk}
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
        <nav className="flex flex-wrap items-center gap-1 border-b border-rule px-3 pt-2">
          {PANE_TABS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => selectView(side, key)}
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
            <button
              onClick={() => runCompile(side)}
              className="ml-auto mb-1 rounded border border-rule px-2.5 py-1 text-xs text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
            >
              Recompile
            </button>
          )}
        </nav>
        <div className="min-h-0 flex-1">
          {/* Panels stay mounted (hidden) in their owning pane so drafts,
              scroll, and the loaded PDF survive tab switches. */}
          {PANE_TABS.map(([key]) =>
            paneOwner.current[key] === side ? (
              <div key={key} className={active === key ? "h-full" : "hidden"}>
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
        />
      )}
    </div>
    </DialogProvider>
  );
}
