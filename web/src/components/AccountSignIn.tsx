import { useState } from "react";
import { api } from "../api";

interface Props {
  /** Called with the instance URL + working cookie once a session is captured. */
  onSession: (url: string, cookie: string) => Promise<void>;
  busy?: boolean;
  autoFocus?: boolean;
}

const INSTANCE_KEY = "blattbot.instance";

/**
 * Sign in to an Overleaf instance: import the session from an installed
 * browser, open a login window, or paste a cookie by hand.
 */
export default function AccountSignIn({ onSession, busy = false, autoFocus = false }: Props) {
  const [instance, setInstance] = useState(
    () => localStorage.getItem(INSTANCE_KEY) ?? "https://www.overleaf.com",
  );
  const [cookie, setCookie] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [grabbing, setGrabbing] = useState<"firefox" | "browser" | "paste" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = busy || grabbing !== null || !instance.trim();

  async function finish(freshCookie: string) {
    localStorage.setItem(INSTANCE_KEY, instance.trim());
    await onSession(instance.trim(), freshCookie);
  }

  async function grab(source: "firefox" | "browser") {
    setGrabbing(source);
    setError(null);
    setMessage(source === "browser" ? "A browser window opened — log in to Overleaf there." : null);
    try {
      const res =
        source === "firefox"
          ? await api.cookieImport(instance.trim())
          : await api.cookieViaBrowser(instance.trim());
      setMessage(`Signed in (session from ${res.source}).`);
      await finish(res.cookie);
    } catch (err: any) {
      setMessage(null);
      setError(err.message);
    } finally {
      setGrabbing(null);
    }
  }

  async function usePasted() {
    if (!cookie.trim()) return;
    setGrabbing("paste");
    setError(null);
    try {
      await finish(cookie.trim());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGrabbing(null);
    }
  }

  return (
    <div>
      <label className="block text-[11px] text-graphite">
        Overleaf instance <span className="text-graphite/60">(or paste a project link)</span>
        <input
          autoFocus={autoFocus}
          value={instance}
          onChange={(e) => setInstance(e.target.value)}
          placeholder="https://www.overleaf.com — or a project link"
          className="mt-1 w-full rounded border border-rule bg-ink px-2.5 py-2 font-mono text-xs text-paper placeholder:text-graphite/60"
        />
      </label>

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => grab("firefox")}
          className="rounded border border-rule px-3 py-1.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
        >
          {grabbing === "firefox" ? "Looking for a session…" : "Sign in from browser session"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => grab("browser")}
          className="rounded border border-rule px-3 py-1.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
        >
          {grabbing === "browser" ? "Waiting for login…" : "Log in via browser"}
        </button>
        <button
          type="button"
          onClick={() => setShowPaste((s) => !s)}
          className="ml-auto text-[11px] text-graphite underline decoration-rule underline-offset-2 hover:text-paper-dim"
        >
          paste cookie
        </button>
      </div>

      {showPaste && (
        <div className="mt-2 flex gap-1.5">
          <input
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            type="password"
            placeholder="overleaf_session2=s%3A… (DevTools → Application → Cookies)"
            className="min-w-0 flex-1 rounded border border-rule bg-ink px-2.5 py-1.5 font-mono text-xs text-paper placeholder:text-graphite/60"
          />
          <button
            type="button"
            disabled={!cookie.trim() || grabbing !== null || busy}
            onClick={usePasted}
            className="rounded border border-rule px-3 py-1.5 text-[12px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
          >
            {grabbing === "paste" ? "Checking…" : "Use this session"}
          </button>
        </div>
      )}

      {message && <p className="mt-2 text-[11.5px] leading-snug text-leaf">{message}</p>}
      {error && <p className="mt-2 text-[11.5px] leading-snug text-pencil">{error}</p>}
    </div>
  );
}
