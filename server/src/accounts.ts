/**
 * Persistent Overleaf accounts: one entry per signed-in instance session
 * (e.g. overleaf.com AND a university Community Edition side by side).
 * Projects reference an account by id instead of carrying their own cookie,
 * so a session survives restarts and can be refreshed in one place.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, ensureDirs, listProjects, updateProject, type Project } from "./config.js";
import { OverleafClient } from "./overleaf/olclient.js";
import { importFromBrowsers } from "./overleaf/cookiegrab.js";

const ACCOUNTS_PATH = join(DATA_DIR, "accounts.json");

export interface OlAccount {
  id: string;
  /** Instance origin, e.g. https://www.overleaf.com */
  baseUrl: string;
  /** Session cookie — the secret. Never sent to the UI. */
  cookie: string;
  email?: string;
  /** "disconnected" = the session expired and auto-refresh failed. The account stays. */
  status: "connected" | "disconnected";
  createdAt: string;
  lastVerifiedAt?: string;
}

function load(): OlAccount[] {
  if (!existsSync(ACCOUNTS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8")) as OlAccount[];
  } catch {
    return [];
  }
}

function save(accounts: OlAccount[]): void {
  ensureDirs();
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

export function listAccounts(): OlAccount[] {
  return load();
}

export function getAccount(id: string): OlAccount | undefined {
  return load().find((a) => a.id === id);
}

export function findAccountByBaseUrl(baseUrl: string): OlAccount | undefined {
  const norm = baseUrl.replace(/\/+$/, "").toLowerCase();
  return load().find((a) => a.baseUrl.replace(/\/+$/, "").toLowerCase() === norm);
}

/**
 * Create or update an account for an instance. Two different logins on the
 * SAME instance stay separate when both emails are known and differ.
 */
export function upsertAccount(input: {
  baseUrl: string;
  cookie: string;
  email?: string;
}): OlAccount {
  const accounts = load();
  const norm = input.baseUrl.replace(/\/+$/, "");
  const existing = accounts.find(
    (a) =>
      a.baseUrl.replace(/\/+$/, "").toLowerCase() === norm.toLowerCase() &&
      (!a.email || !input.email || a.email === input.email),
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.cookie = input.cookie;
    existing.status = "connected";
    existing.lastVerifiedAt = now;
    if (input.email) existing.email = input.email;
    save(accounts);
    return existing;
  }
  const host = new URL(norm).hostname.replace(/^www\./, "");
  const account: OlAccount = {
    id: `${host.replace(/[^a-z0-9]+/gi, "-")}-${randomBytes(3).toString("hex")}`,
    baseUrl: norm,
    cookie: input.cookie,
    email: input.email,
    status: "connected",
    createdAt: now,
    lastVerifiedAt: now,
  };
  accounts.push(account);
  save(accounts);
  return account;
}

export function updateAccount(id: string, patch: Partial<OlAccount>): OlAccount | undefined {
  const accounts = load();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return undefined;
  accounts[idx] = { ...accounts[idx], ...patch, id };
  save(accounts);
  return accounts[idx];
}

export function removeAccount(id: string): boolean {
  const accounts = load();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  save(next);
  return true;
}

/** Public view — everything except the cookie. */
export function publicAccount(a: OlAccount) {
  const { cookie, ...rest } = a;
  return { ...rest, host: new URL(a.baseUrl).hostname };
}

/** The session cookie a project should use: its account's, or its own legacy one. */
export function cookieForProject(project: Project): string | undefined {
  if (project.accountId) return getAccount(project.accountId)?.cookie;
  return project.cookie;
}

/** Whether an instance actually accepts a cookie right now. */
export async function cookieWorks(baseUrl: string, cookie: string): Promise<boolean> {
  try {
    await new OverleafClient(baseUrl, cookie).csrf();
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to silently revive an expired account session from the user's browser
 * cookie stores. Returns true when a working cookie was installed.
 */
export async function refreshFromBrowsers(account: OlAccount): Promise<boolean> {
  let candidates: { cookie: string; source: string }[] = [];
  try {
    candidates = importFromBrowsers(account.baseUrl);
  } catch {
    return false;
  }
  for (const c of candidates) {
    if (c.cookie === account.cookie) continue; // that one just failed
    if (await cookieWorks(account.baseUrl, c.cookie)) {
      updateAccount(account.id, {
        cookie: c.cookie,
        status: "connected",
        lastVerifiedAt: new Date().toISOString(),
      });
      return true;
    }
  }
  return false;
}

/**
 * One-time migration: older registries stored the cookie on each project.
 * Fold those into accounts and link the projects.
 */
export function migrateProjectCookies(): void {
  for (const p of listProjects()) {
    if (p.kind !== "overleaf" || p.accountId || !p.cookie || !p.overleafBaseUrl) continue;
    const account =
      findAccountByBaseUrl(p.overleafBaseUrl) ??
      upsertAccount({ baseUrl: p.overleafBaseUrl, cookie: p.cookie });
    updateProject(p.id, { accountId: account.id, cookie: undefined });
  }
}
