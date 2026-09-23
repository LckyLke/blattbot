import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string, app: import("fastify").FastifyInstance, id: string, token: string;
const base = "http://127.0.0.1:4689";
const realFetch = globalThis.fetch;
const bib = "@inproceedings{alpha,title={Graph Models},doi={10.1234/alpha},booktitle={GraphConf}}";
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-ref-routes-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.stubEnv("BLATTBOT_PORT", "4689");
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (String(input).startsWith("https://portal.core.edu.au/")) return new Response(String(input).includes("do=Export")
      ? "123,Graph Conference,GraphConf,ICORE2026,B,Yes,4602,,\r\n"
      : '<select name="source"><option value="ICORE2026">ICORE2026</option></select>', { status: 200 });
    if (String(input).startsWith("https://api.semanticscholar.org/")) return new Response(JSON.stringify({ title: "Graph Models", citationCount: 21, url: "https://www.semanticscholar.org/paper/alpha" }), { status: 200 });
    if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
    return new Response("{}", { status: 404 });
  }));
  ({ app } = await import("../src/index.js"));
  token = (await (await fetch(`${base}/api/bootstrap`)).json()).token;
  const config = await import("../src/config.js");
  id = config.addProject({ name: "References", kind: "local", gitUrl: "" }).id;
  const dir = config.projectDir(id);
  mkdirSync(dir);
  writeFileSync(join(dir, "refs.bib"), bib);
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const get = (path: string) => fetch(`${base}/api/projects/${id}/refs${path}`, { headers: { Authorization: `Bearer ${token}` } });

it("loads local venue first, then persists enriched metadata into the reference list", async () => {
  let list = await (await get("")).json();
  expect(list.entries[0]).toMatchObject({ metadata: { venue: "GraphConf" }, metadataNeedsRefresh: true });
  const details = await (await get("/alpha/metadata?file=refs.bib")).json();
  expect(details).toMatchObject({ raw: bib, metadata: { citationCount: 21, citationSource: "Semantic Scholar", venue: "GraphConf", conferenceRanking: { rank: "B", edition: "ICORE2026" } } });
  list = await (await get("")).json();
  expect(list.entries[0]).toMatchObject({ metadata: { citationCount: 21 }, metadataNeedsRefresh: false });
});
it("requires authentication and rejects unknown references and wrong bibliography files", async () => {
  expect((await realFetch(`${base}/api/projects/${id}/refs/alpha/metadata`)).status).toBe(401);
  expect((await get("/missing/metadata")).status).toBe(404);
  expect((await get("/alpha/metadata?file=wrong.bib")).status).toBe(404);
});
