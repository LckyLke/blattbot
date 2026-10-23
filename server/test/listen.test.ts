import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { blattbotAnswers, explainListenError, listenOrExit, setOpenBrowserOnConflict } from "../src/listen.js";

const inUse = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
const servers: Server[] = [];

/** A local HTTP server on a free port answering every request with `status` + `body`. */
async function answer(status: number, body: string): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": body.startsWith("{") ? "application/json" : "text/html" });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

afterEach(async () => {
  setOpenBrowserOnConflict(false);
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("blattbotAnswers", () => {
  it("recognizes BlattBot's health reply, with or without the right token", async () => {
    expect(await blattbotAnswers(await answer(200, JSON.stringify({ ok: true, engine: null })))).toBe(true);
    expect(await blattbotAnswers(await answer(401, JSON.stringify({ error: "unauthorized — reload the BlattBot tab" })))).toBe(true);
  });

  it("does not mistake other servers or a closed port for BlattBot", async () => {
    expect(await blattbotAnswers(await answer(200, "<html>dev server</html>"))).toBe(false);
    expect(await blattbotAnswers(await answer(401, JSON.stringify({ error: "nope" })))).toBe(false);
    expect(await blattbotAnswers(await closedPort())).toBe(false);
  });
});

describe("explainListenError", () => {
  it("explains a port held by something else", async () => {
    const port = await answer(404, "<html>not BlattBot</html>");
    const result = await explainListenError(inUse, port);
    expect(result.exitCode).toBe(1);
    expect(result.message).toBe(
      `Port ${port} is busy. Is BlattBot already running? Open http://127.0.0.1:${port} or use --port <n> (env BLATTBOT_PORT) to pick another port.`,
    );
    expect(result.open).toBeUndefined();
  });

  it("exits 0 for a BlattBot already running there, opening it only when asked", async () => {
    const port = await answer(200, JSON.stringify({ ok: true }));
    expect(await explainListenError(inUse, port)).toEqual({
      message: `BlattBot is already running at http://127.0.0.1:${port}.`,
      exitCode: 0,
    });
    setOpenBrowserOnConflict(true);
    expect(await explainListenError(inUse, port)).toMatchObject({ exitCode: 0, open: `http://127.0.0.1:${port}` });
  });

  it("explains other listen failures", async () => {
    const denied = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    expect((await explainListenError(denied, 80)).message).toMatch(/Not allowed to listen on port 80/);
    expect(await explainListenError(new Error("boom"), 4560)).toMatchObject({ exitCode: 1, message: expect.stringContaining("boom") });
  });
});

describe("listenOrExit", () => {
  it("prints the explanation instead of a stack trace and exits with its code", async () => {
    const port = await answer(404, "busy");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await listenOrExit({ listen: async () => { throw inUse; } }, port);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Port \d+ is busy\. Is BlattBot already running\?/));
  });

  it("returns normally once listening", async () => {
    const listen = vi.fn(async () => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await listenOrExit({ listen }, 4560);
    expect(listen).toHaveBeenCalledWith({ port: 4560, host: "127.0.0.1" });
    expect(exit).not.toHaveBeenCalled();
  });
});
