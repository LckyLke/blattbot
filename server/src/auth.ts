/**
 * Local API security. The server binds to loopback, but browsers can still be
 * tricked into firing requests at it (malicious pages, DNS rebinding), so:
 *  - every request must carry an allowlisted Host header (kills DNS rebinding);
 *  - every /api request must present the local auth token, either as a
 *    Bearer header (scripts) or the SameSite=Strict cookie the app receives
 *    from /api/bootstrap (cross-site pages can neither read nor send it).
 * The token is generated once and stored 0600 in the data dir.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, ensureDirs } from "./config.js";

const TOKEN_PATH = join(DATA_DIR, "auth-token");
export const AUTH_COOKIE = "blattbot_token";

let cached: string | null = null;

export function getAuthToken(): string {
  if (cached) return cached;
  if (existsSync(TOKEN_PATH)) {
    const t = readFileSync(TOKEN_PATH, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(t)) {
      cached = t;
      return t;
    }
  }
  ensureDirs();
  const t = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_PATH, t + "\n", { mode: 0o600 });
  cached = t;
  return t;
}

/** Hosts a local UI or proxy may legitimately use to reach this server. */
export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  return Boolean(hostHeader) && allowedHosts(port).has(hostHeader!.toLowerCase());
}

/** Minimal cookie-header parser — just enough to find our own cookie. */
export function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export interface AuthHeaders {
  authorization?: string;
  cookie?: string;
}

/** True when the request presents the local token via Bearer header or cookie. */
export function requestAuthorized(headers: AuthHeaders, token = getAuthToken()): boolean {
  if (headers.authorization === `Bearer ${token}`) return true;
  return cookieValue(headers.cookie, AUTH_COOKIE) === token;
}
