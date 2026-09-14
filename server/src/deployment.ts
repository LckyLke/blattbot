import type { FastifyInstance } from "fastify";

/** A deployment pauses new writes while existing turns/requests finish.
 * The lease expires if an updater crashes, so the app cannot stay locked. */
export function registerDeployment(app: FastifyInstance, backgroundBusy: () => boolean): void {
  let drainingUntil = process.env.BLATTBOT_START_DRAINED === "1" ? Date.now() + 120_000 : 0;
  const writes = new Set<string>();
  const draining = () => Date.now() < drainingUntil;
  app.addHook("onRequest", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.url.startsWith("/api/deployment")) return;
    if (draining()) return reply.code(503).header("Retry-After", "15").send({ error: "BlattBot is updating. Your data is saved; please retry shortly." });
    writes.add(req.id);
  });
  app.addHook("onResponse", async (req) => { writes.delete(req.id); });
  const status = () => ({
    revision: process.env.BLATTBOT_REVISION || null,
    draining: draining(),
    idle: writes.size === 0 && !backgroundBusy(),
  });
  app.get("/api/deployment", async () => status());
  app.post<{ Body: { drain?: boolean } }>("/api/deployment/drain", async (req, reply) => {
    if (typeof req.body?.drain !== "boolean") return reply.code(400).send({ error: "drain must be boolean" });
    drainingUntil = req.body.drain ? Date.now() + 120_000 : 0;
    return status();
  });
}
