/** User-driven publisher sign-in. University credentials never enter agent tools. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Cookie } from "playwright-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DATA_DIR, ensureDirs } from "./config.js";
import { publicAddress } from "./read-url.js";
import { findChromiumExecutable } from "./overleaf/cookiegrab.js";

const path = join(DATA_DIR, "research-secrets", "publisher-access.json");
interface PublisherSession {
  id: string;
  origin: string;
  institution: string;
  savedAt: string;
  revision: string;
  cookies: Cookie[];
}
const cookieActive = (cookie: Cookie) => cookie.expires === -1 || cookie.expires > Date.now() / 1000;
function domainMatches(cookie: Cookie, hostname: string): boolean {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  return hostname === domain || (cookie.domain.startsWith(".") && hostname.endsWith("." + domain));
}
function readSessions(): PublisherSession[] {
  if (!existsSync(path)) return [];
  // Fail closed on damaged credential storage; never silently overwrite it.
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Saved publisher connections could not be read. Restore the publisher-access file from a backup or remove the damaged file before reconnecting."); }
}
function writeSessions(sessions: PublisherSession[]) {
  ensureDirs();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(sessions), { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export function publisherOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new Error("Use the publisher's public HTTPS website, without a password or custom port.");
  return url.origin;
}
export function listPublisherAccess() {
  return readSessions().map(session => ({ id: session.id, origin: session.origin, institution: session.institution, savedAt: session.savedAt, status: session.cookies.some(cookieActive) ? "saved" as const : "expired" as const }));
}
export function publisherAccessRevision(): string {
  return readSessions().map(session => session.revision).sort().join(":");
}
export function hasPublisherAccess(raw: string): boolean {
  try { return listPublisherAccess().some(session => session.origin === new URL(raw).origin); }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
}
export function savePublisherSession(origin: string, institution: string, cookies: Cookie[]) {
  const target = new URL(publisherOrigin(origin));
  const scoped = cookies.filter(cookie => cookieActive(cookie) && domainMatches(cookie, target.hostname) &&
    !/[\r\n;=]/.test(cookie.name) && !/[\r\n;]/.test(cookie.value));
  if (!scoped.length) throw new Error("No publisher session was found. Complete institution sign-in and return to the publisher before saving.");
  const sessions = readSessions();
  const old = sessions.find(session => session.origin === target.origin);
  const session: PublisherSession = { id: old?.id ?? randomUUID(), origin: target.origin, institution: institution.trim().slice(0, 200), savedAt: new Date().toISOString(), revision: randomUUID(), cookies: scoped };
  writeSessions([...sessions.filter(item => item.id !== session.id), session]);
  return listPublisherAccess().find(item => item.id === session.id)!;
}
export function removePublisherAccess(id: string) {
  writeSessions(readSessions().filter(session => session.id !== id));
}
/** Exact opted-in origin, cookie domain, path and expiration all have to match. */
export function publisherCookieForUrl(url: URL): string | undefined {
  if (url.protocol !== "https:" || url.username || url.password) return;
  const session = readSessions().find(item => item.origin === url.origin);
  if (!session) return;
  const cookies = session.cookies.filter(cookie => {
    const path = cookie.path || "/";
    return cookieActive(cookie) && domainMatches(cookie, url.hostname) &&
      (url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/")));
  }).sort((a, b) => b.path.length - a.path.length);
  return cookies.length ? cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") : undefined;
}

interface Login {
  id: string;
  origin: string;
  institution: string;
  browser: Browser;
  context: BrowserContext;
  timer: ReturnType<typeof setTimeout>;
}
let login: Login | undefined;
let opening = false;
let finishing = false;
export function publisherLoginStatus() {
  return login ? { id: login.id, origin: login.origin, institution: login.institution } : null;
}
export async function cancelPublisherLogin(id?: string) {
  if (!login || (id && login.id !== id)) return;
  const active = login;
  login = undefined;
  clearTimeout(active.timer);
  await active.browser.close().catch(() => {});
}
export async function startPublisherLogin(raw: string, institution: string, launch?: () => Promise<Browser>) {
  if (login || opening || finishing) throw new Error("A publisher sign-in is already open. Finish or cancel it first.");
  const origin = publisherOrigin(raw);
  opening = true;
  let browser: Browser | undefined;
  try {
    const addresses = await lookup(new URL(origin).hostname, { all: true });
    if (!addresses.length || addresses.some(address => !publicAddress(address.address)))
      throw new Error("Use a public publisher website; local and private network addresses are not supported.");
    if (launch) browser = await launch();
    else {
      const executablePath = process.env.BLATTBOT_BROWSER_EXECUTABLE || findChromiumExecutable();
      if (!executablePath) throw new Error("Install Chrome, Edge or Chromium on the machine running Blattbot to open the sign-in window.");
      const { chromium } = await import("playwright-core");
      try { browser = await chromium.launch({ executablePath, headless: false }); }
      catch { throw new Error("Could not open a browser window on this machine. A desktop display and Chrome/Chromium are required. You can also download the PDF in your normal browser and attach it under External context."); }
    }
    // Nonpersistent context: university SSO cookies, passwords and local storage
    // are not exported. Only matching publisher cookies are saved on Finish.
    const context = await browser.newContext({ acceptDownloads: false });
    const existing = readSessions().find(session => session.origin === origin);
    if (existing) await context.addCookies(existing.cookies.filter(cookieActive));
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    const id = randomUUID();
    const timer = setTimeout(() => { void cancelPublisherLogin(id); }, 10 * 60_000);
    timer.unref();
    login = { id, origin, institution: institution.trim().slice(0, 200), browser, context, timer };
    browser.on("disconnected", () => { if (login?.id === id) { clearTimeout(login.timer); login = undefined; } });
    if (!browser.isConnected()) { await cancelPublisherLogin(id); throw new Error("The sign-in window was closed. Open it again to continue."); }
    return publisherLoginStatus()!;
  } catch (error) { if (browser) await browser.close().catch(() => {}); throw error; }
  finally { opening = false; }
}
export async function finishPublisherLogin(id: string) {
  if (!login || login.id !== id) throw new Error("The sign-in window is no longer open. Start again.");
  if (finishing) throw new Error("The sign-in is already being saved.");
  finishing = true;
  const active = login;
  try {
    const pages = active.context.pages();
    const current = pages[pages.length - 1];
    if (!current || !current.url().startsWith(active.origin + "/"))
      throw new Error("Finish signing in and return to the publisher website before saving.");
    const cookies = await active.context.cookies();
    if (login?.id !== id) throw new Error("Sign-in was cancelled or expired. Start again.");
    const saved = savePublisherSession(active.origin, active.institution, cookies);
    await cancelPublisherLogin(id);
    return saved;
  } finally { finishing = false; }
}

/** UI-only endpoints. No agent tool can open, inspect or manage login windows. */
export function registerPublisherAccess(app: FastifyInstance) {
  app.get("/api/publisher-access", async () => ({ connections: listPublisherAccess(), login: publisherLoginStatus() }));
  app.post("/api/publisher-access/login", async (request, reply) => {
    const parsed = z.object({ url: z.string().url().max(2000), institution: z.string().max(200).default("") }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid publisher website and an optional institution name." });
    try { return await startPublisherLogin(parsed.data.url, parsed.data.institution); }
    catch (error: any) { return reply.code(422).send({ error: error.message }); }
  });
  app.post<{ Params: { id: string } }>("/api/publisher-access/login/:id/finish", async (request, reply) => {
    try { return await finishPublisherLogin(request.params.id); }
    catch (error: any) { return reply.code(422).send({ error: error.message }); }
  });
  app.delete<{ Params: { id: string } }>("/api/publisher-access/login/:id", async request => { await cancelPublisherLogin(request.params.id); return { ok: true }; });
  app.delete<{ Params: { id: string } }>("/api/publisher-access/:id", async (request, reply) => {
    if (login || opening || finishing) return reply.code(409).send({ error: "Finish or cancel the open sign-in before removing a connection." });
    removePublisherAccess(request.params.id); return { ok: true };
  });
  app.addHook("onClose", async () => { await cancelPublisherLogin(); });
}
