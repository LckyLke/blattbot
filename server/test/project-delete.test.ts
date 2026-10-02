import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock("../src/agent.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent.js")>(), runTurn: mocks.turn,
}));

let app: import("fastify").FastifyInstance;
let root: string, token: string;
const call = (method: "GET" | "POST" | "DELETE", path: string, payload?: Record<string, unknown>) => app.inject({
  method, url: path, payload,
  headers: { host: "127.0.0.1:4690", authorization: `Bearer ${token}` },
});
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-project-delete-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.stubEnv("BLATTBOT_PORT", "4690");
  ({ app } = await import("../src/index.js"));
  token = (await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "127.0.0.1:4690" } })).json().token;
});
afterAll(async () => {
  await app?.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

async function createProject(name: string): Promise<string> {
  const created = await call("POST", "/api/projects", { local: true, name });
  expect(created.statusCode, created.body).toBe(200);
  return created.json().id;
}

it("removes everything stored for the project, including model conversation logs", async () => {
  const id = await createProject("Doomed");
  const { activeChatId } = (await call("GET", `/api/projects/${id}/chats`)).json();
  const chats = await import("../src/chats.js");
  chats.updateChat(id, activeChatId, { sessionId: "oai-0123456789abcdef" });
  mkdirSync(join(root, "oai-sessions"), { recursive: true });
  writeFileSync(join(root, "oai-sessions", "oai-0123456789abcdef.json"), "[]");
  writeFileSync(join(root, "oai-sessions", "oai-ffffffffffffffff.json"), "[]"); // another project's
  mkdirSync(join(root, "research", id), { recursive: true });
  writeFileSync(join(root, "research", id, "graph.json"), "{}");
  mkdirSync(join(root, "papers", id), { recursive: true });
  writeFileSync(join(root, "papers", `${id}.json`), "{}");
  writeFileSync(join(root, "papers", `${id}.audit.json`), "{}");

  expect((await call("DELETE", `/api/projects/${id}`)).statusCode).toBe(200);
  for (const path of [join(root, "projects", id), join(root, "chats", id), join(root, "research", id),
    join(root, "papers", id), join(root, "papers", `${id}.json`), join(root, "papers", `${id}.audit.json`)]) {
    expect(existsSync(path), path).toBe(false);
  }
  expect(readdirSync(join(root, "oai-sessions"))).toEqual(["oai-ffffffffffffffff.json"]);
});

it("deleting one chat drops that chat's stored conversation", async () => {
  const id = await createProject("Chats");
  const { activeChatId } = (await call("GET", `/api/projects/${id}/chats`)).json();
  const chats = await import("../src/chats.js");
  chats.updateChat(id, activeChatId, { sessionId: "oai-aaaaaaaaaaaaaaaa" });
  writeFileSync(join(root, "oai-sessions", "oai-aaaaaaaaaaaaaaaa.json"), "[]");
  expect((await call("DELETE", `/api/projects/${id}/chats/${activeChatId}`)).statusCode).toBe(200);
  expect(existsSync(join(root, "oai-sessions", "oai-aaaaaaaaaaaaaaaa.json"))).toBe(false);
});

it("refuses while a turn is running, which would recreate the folders", async () => {
  const id = await createProject("Busy");
  let finish!: () => void;
  mocks.turn.mockImplementationOnce(async (_p, _m, sink) => {
    await new Promise<void>((resolve) => (finish = resolve));
    sink({ type: "turn_end", durationMs: 1 });
  });
  expect((await call("POST", `/api/projects/${id}/chat`, { message: "work" })).statusCode).toBe(200);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const refused = await call("DELETE", `/api/projects/${id}`);
  expect(refused.statusCode).toBe(409);
  expect(existsSync(join(root, "projects", id))).toBe(true);
  finish();
  await vi.waitFor(async () => expect((await call("GET", `/api/projects/${id}`)).json().turnActive).toBe(false));
  expect((await call("DELETE", `/api/projects/${id}`)).statusCode).toBe(200);
});
