import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("uses verified DOI metadata after arXiv rate limiting and caches the result", async () => {
  vi.resetModules();
  const fetcher = vi.fn(async (url: any) => String(url).includes("export.arxiv.org")
    ? new Response("", { status: 429, headers: { "Retry-After": "120" } })
    : new Response("@misc{paper,title={Example},doi={10.48550/arXiv.2106.06935}}"));
  vi.stubGlobal("fetch", fetcher);
  const { fetchBibtexByRef } = await import("../src/citations.js");
  expect(await fetchBibtexByRef("arxiv:2106.06935")).toContain("Example");
  const calls = fetcher.mock.calls.length;
  await fetchBibtexByRef("arxiv:2106.06935");
  expect(fetcher).toHaveBeenCalledTimes(calls);
});
it("does not hammer arXiv during Retry-After or accept another paper's metadata", async () => {
  vi.resetModules();
  const fetcher = vi.fn(async (url: any) => String(url).includes("export.arxiv.org")
    ? new Response("", { status: 429, headers: { "Retry-After": "120" } })
    : new Response("@misc{wrong,title={Wrong paper},doi={10.9999/wrong}}"));
  vi.stubGlobal("fetch", fetcher);
  const { fetchBibtexByRef } = await import("../src/citations.js");
  await expect(fetchBibtexByRef("arxiv:2106.06935")).rejects.toMatchObject({ status: 429, retryAt: expect.any(String) });
  await expect(fetchBibtexByRef("arxiv:2106.06936")).rejects.toThrow("did not match");
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("export.arxiv.org"))).toHaveLength(1);
});
