import { useEffect, useState } from "react";
import { api, type PublisherConnection, type PublisherLogin } from "../api";

const publishers = [
  ["ScienceDirect", "https://www.sciencedirect.com"],
  ["Springer Nature", "https://link.springer.com"],
  ["Cambridge Core", "https://www.cambridge.org"],
  ["Wiley Online Library", "https://onlinelibrary.wiley.com"],
] as const;

export default function UniversityAccess() {
  const [connections, setConnections] = useState<PublisherConnection[]>([]);
  const [login, setLogin] = useState<PublisherLogin | null>(null);
  const [url, setUrl] = useState<string>(publishers[0][1]);
  const [institution, setInstitution] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function refresh() {
    const state = await api.publisherAccess();
    setConnections(state.connections);
    setLogin(state.login);
  }
  useEffect(() => { void refresh().catch(err => setError(err.message)); }, []);
  useEffect(() => {
    if (!login) return;
    const timer = setInterval(() => { void refresh().catch(err => setError(err.message)); }, 3000);
    return () => clearInterval(timer);
  }, [login?.id]);
  async function action(run: () => Promise<unknown>, success = "") {
    setBusy(true); setError(""); setMessage("");
    try { await run(); await refresh(); setMessage(success); }
    catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }
  const button = "rounded border border-rule px-3 py-1.5 text-xs text-paper disabled:opacity-50";
  return <div className="max-w-[560px] space-y-4">
    <p className="font-serif text-sm leading-relaxed text-graphite">Connect a publisher through your university or library. Choose your institution on the publisher’s sign-in page and complete any two-factor authentication there. This works independently of which university you attend; article access depends on its subscriptions.</p>
    {error && <p role="alert" className="text-xs text-pencil">{error}</p>}
    {message && <p role="status" className="text-xs text-leaf">{message}</p>}
    {login ? <div className="space-y-3 rounded border border-leaf/40 bg-ink p-3">
      <p className="text-sm text-paper">Sign-in window open for {new URL(login.origin).hostname}</p>
      <p className="text-xs leading-relaxed text-graphite">In that window, choose “Sign in via your institution”, select your university, and finish signing in. Return to the publisher website, then save below. The window closes after ten minutes if left unfinished.</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={() => void action(() => api.finishPublisherLogin(login.id), "Publisher session saved. Retry reading the paper to check access.")}>Save publisher session</button>
        <button className={button} disabled={busy} onClick={() => void action(() => api.cancelPublisherLogin(login.id))}>Cancel sign-in</button>
      </div>
    </div> : <form className="space-y-3 rounded border border-rule bg-ink p-3" onSubmit={event => { event.preventDefault(); void action(() => api.startPublisherLogin(url, institution)); }}>
      <label className="block text-xs text-graphite">Publisher
        <select aria-label="Publisher" className="mt-1 block w-full rounded border border-rule bg-ink px-2 py-2 text-paper" value={publishers.some(([, value]) => value === url) ? url : "custom"} onChange={event => setUrl(event.target.value === "custom" ? "" : event.target.value)}>
          {publishers.map(([name, value]) => <option key={value} value={value}>{name}</option>)}
          <option value="custom">Another publisher or library website</option>
        </select>
      </label>
      <label className="block text-xs text-graphite">Publisher website
        <input required type="url" value={url} placeholder="https://publisher.example" onChange={event => setUrl(event.target.value)} className="mt-1 block w-full rounded border border-rule bg-ink px-2 py-2 text-paper" />
      </label>
      <label className="block text-xs text-graphite">Institution label (optional)
        <input value={institution} maxLength={200} placeholder="Your university or library" onChange={event => setInstitution(event.target.value)} className="mt-1 block w-full rounded border border-rule bg-ink px-2 py-2 text-paper" />
      </label>
      <button type="submit" disabled={busy} className={button}>{busy ? "Opening…" : "Open institution sign-in"}</button>
      <p className="text-[11px] leading-relaxed text-graphite">Opens a separate browser window on the computer running Blattbot. Enter the publisher’s website above, not the university’s login page. Your password is entered only in that browser.</p>
    </form>}
    {connections.length > 0 && <ul className="space-y-3" aria-label="Saved publisher connections">
      {connections.map(connection => <li key={connection.id} className="rounded border border-rule p-3">
        <p className="text-sm text-paper">{new URL(connection.origin).hostname}</p>
        {connection.institution && <p className="mt-1 text-xs text-graphite">{connection.institution}</p>}
        <p className="mt-1 text-xs text-graphite">{connection.status === "expired" ? "Session expired — reconnect to retry." : "Session saved — access is checked when retrieving a paper."}</p>
        <div className="mt-2 flex gap-2">
          <button className={button} disabled={busy || !!login} onClick={() => void action(() => api.startPublisherLogin(connection.origin, connection.institution))}>Reconnect</button>
          <button className={button} disabled={busy || !!login} onClick={() => void action(() => api.removePublisherAccess(connection.id), "Saved publisher session removed.")}>Remove</button>
        </div>
      </li>)}
    </ul>}
    <p className="text-[11px] leading-relaxed text-graphite">Only cookies for the selected publisher website are retained locally. Cookies from other sign-in websites are discarded when the window closes. The agent receives paper content, never these credentials. Removing a connection deletes its saved session; previously downloaded papers remain in your library.</p>
    <p className="text-[11px] leading-relaxed text-graphite">Some publishers require an API or a manual download even after sign-in. Access is not guaranteed on every site. For ScienceDirect automation, Elsevier provides an <a href="https://dev.elsevier.com/text_mining.html" target="_blank" rel="noreferrer" className="text-leaf">official retrieval API ↗</a>. PDFs downloaded in your normal browser can be attached under External context.</p>
  </div>;
}
