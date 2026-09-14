import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerDeployment } from "../src/deployment.js";

describe("deployment drain", () => {
  it("blocks new writes, preserves reads, reports busy work and expires its lease", async () => {
    const app = Fastify();
    let busy = true;
    registerDeployment(app, () => busy);
    app.post("/api/edit", async () => ({ ok: true }));
    try {
      expect((await app.inject({ method: "POST", url: "/api/deployment/drain", payload: { drain: true } })).json()).toMatchObject({ draining: true, idle: false });
      expect((await app.inject({ method: "POST", url: "/api/edit" })).statusCode).toBe(503);
      busy = false;
      expect((await app.inject("/api/deployment")).json().idle).toBe(true);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
      expect((await app.inject({ method: "POST", url: "/api/edit" })).statusCode).toBe(200);
      clock.mockRestore();
      expect((await app.inject({ method: "POST", url: "/api/deployment/drain", payload: { drain: false } })).json().draining).toBe(false);
    } finally { vi.restoreAllMocks(); await app.close(); }
  });
});
