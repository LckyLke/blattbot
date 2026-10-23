// Overleaf accounts, their project lists, and session-cookie capture.
import type { FastifyInstance } from "fastify";
import { listProjects } from "../config.js";
import { OverleafAuthError, OverleafClient, canonicalOrigin } from "../overleaf/olclient.js";
import { captureViaBrowser, noSessionMessage, scanBrowsers } from "../overleaf/cookiegrab.js";
import {
  cookieWorks,
  getAccount,
  listAccounts,
  publicAccount,
  refreshFromBrowsers,
  removeAccount,
  updateAccount,
  upsertAccount,
} from "../accounts.js";
import { normalizeCookie } from "../http-helpers.js";

// ---- Overleaf accounts -----------------------------------------------------

/** Projects per account, for the UI. */
function accountProjectCount(accountId: string): number {
  return listProjects().filter((p) => p.accountId === accountId).length;
}

export function registerAccountRoutes(app: FastifyInstance): void {
  app.get("/api/accounts", async () =>
    listAccounts().map((a) => ({ ...publicAccount(a), projectCount: accountProjectCount(a.id) })),
  );

  app.post<{ Body: { url?: string; cookie?: string } }>("/api/accounts", async (req, reply) => {
    const rawUrl = (req.body?.url ?? "").trim();
    const rawCookie = (req.body?.cookie ?? "").trim();
    if (!rawUrl || !rawCookie) return reply.code(400).send({ error: "url and cookie are required" });
    let base: string;
    try {
      base = await canonicalOrigin(rawUrl);
    } catch {
      return reply.code(400).send({ error: "not a valid URL" });
    }
    const cookie = normalizeCookie(rawCookie);
    if (!(await cookieWorks(base, cookie))) {
      return reply.code(422).send({ error: `${new URL(base).hostname} rejected the session — log in again.` });
    }
    const email = await new OverleafClient(base, cookie).userEmail();
    const account = upsertAccount({ baseUrl: base, cookie, email });
    return { ...publicAccount(account), projectCount: accountProjectCount(account.id) };
  });

  app.post<{ Params: { id: string }; Body: { mode?: "import" | "browser" } }>(
    "/api/accounts/:id/refresh",
    async (req, reply) => {
      const account = getAccount(req.params.id);
      if (!account) return reply.code(404).send({ error: "unknown account" });
      const mode = req.body?.mode ?? "import";
      try {
        if (mode === "import") {
          if (!(await refreshFromBrowsers(account))) {
            const host = new URL(account.baseUrl).hostname;
            const scan = scanBrowsers(account.baseUrl);
            return reply.code(422).send({
              error:
                scan.found.length > 0
                  ? `Found a ${host} session in ${scan.found.map((c) => c.source).join(", ")}, but the instance rejected it — log in to Overleaf again there, then retry.`
                  : noSessionMessage(host, scan),
            });
          }
        } else {
          const found = await captureViaBrowser(account.baseUrl);
          const cookie = normalizeCookie(found.cookie);
          if (!(await cookieWorks(account.baseUrl, cookie))) {
            return reply.code(422).send({ error: "the captured session was rejected — try again" });
          }
          const email = await new OverleafClient(account.baseUrl, cookie).userEmail();
          updateAccount(account.id, {
            cookie,
            email: email ?? account.email,
            status: "connected",
            lastVerifiedAt: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        return reply.code(422).send({ error: err.message });
      }
      const fresh = getAccount(account.id)!;
      return { ...publicAccount(fresh), projectCount: accountProjectCount(fresh.id) };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req, reply) => {
    const account = getAccount(req.params.id);
    if (!account) return reply.code(404).send({ error: "unknown account" });
    const used = listProjects().filter((p) => p.accountId === account.id);
    if (used.length > 0) {
      return reply.code(409).send({
        error: `${used.length} project(s) still use this account (${used.map((p) => p.name).join(", ")}) — remove them first.`,
      });
    }
    removeAccount(account.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/accounts/:id/projects", async (req, reply) => {
    const account = getAccount(req.params.id);
    if (!account) return reply.code(404).send({ error: "unknown account" });
    const list = async () => new OverleafClient(account.baseUrl, getAccount(account.id)!.cookie).listProjects();
    try {
      return { baseUrl: account.baseUrl, projects: await list() };
    } catch (err: any) {
      if (err instanceof OverleafAuthError && (await refreshFromBrowsers(account))) {
        try {
          return { baseUrl: account.baseUrl, projects: await list() };
        } catch {
          /* fall through */
        }
      }
      if (err instanceof OverleafAuthError) {
        updateAccount(account.id, { status: "disconnected" });
        return reply.code(401).send({
          error: `The ${new URL(account.baseUrl).hostname} session has expired — reconnect the account.`,
        });
      }
      return reply.code(422).send({ error: err.message });
    }
  });

  app.post<{ Body: { url?: string; cookie?: string } }>("/api/overleaf/projects", async (req, reply) => {
    const rawUrl = (req.body?.url ?? "").trim();
    const rawCookie = (req.body?.cookie ?? "").trim();
    if (!rawUrl) return reply.code(400).send({ error: "url is required" });
    if (!rawCookie) return reply.code(400).send({ error: "cookie is required" });
    let base: string;
    try {
      base = await canonicalOrigin(rawUrl);
    } catch {
      return reply.code(400).send({ error: "not a valid URL" });
    }
    const client = new OverleafClient(base, normalizeCookie(rawCookie));
    try {
      const projects = await client.listProjects();
      return { baseUrl: base, projects };
    } catch (err: any) {
      return reply.code(422).send({ error: err.message });
    }
  });

  app.post<{ Body: { url: string } }>("/api/cookies/import", async (req, reply) => {
    let base: string;
    try {
      base = await canonicalOrigin((req.body?.url ?? "").trim());
    } catch {
      return reply.code(400).send({ error: "url is required" });
    }
    const host = new URL(base).hostname;
    const scan = scanBrowsers(base);
    const candidates = scan.found;
    if (candidates.length === 0) {
      return reply.code(404).send({ error: noSessionMessage(host, scan) });
    }
    // Return the first candidate the instance actually accepts.
    let sawExpired = false;
    for (const c of candidates) {
      if (await cookieWorks(base, c.cookie)) return { cookie: c.cookie, source: c.source };
      sawExpired = true;
    }
    return reply.code(422).send({
      error: sawExpired
        ? `Found a session in ${candidates.map((c) => c.source).join(", ")}, but ${host} rejected it — log in to Overleaf again there, then retry.`
        : `No usable session for ${host}.`,
    });
  });

  app.post<{ Body: { url: string } }>("/api/cookies/browser", async (req, reply) => {
    let base: string;
    try {
      base = await canonicalOrigin((req.body?.url ?? "").trim());
    } catch {
      return reply.code(400).send({ error: "url is required" });
    }
    try {
      const found = await captureViaBrowser(base);
      return { cookie: found.cookie, source: found.source };
    } catch (err: any) {
      return reply.code(422).send({ error: err.message });
    }
  });
}
