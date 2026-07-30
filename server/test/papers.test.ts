import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let projectDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "blattbot-papers-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "blattbot-papers-proj-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

async function load() {
  return await import("../src/papers.js");
}

const jsonRes = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const pdfRes = () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4 fake pdf body").buffer,
});

function writeBib(content: string) {
  writeFileSync(join(projectDir, "refs.bib"), content);
}

const DOI_ENTRY = `@article{lecun2015deep,
  title = {Deep learning},
  author = {LeCun, Yann},
  year = {2015},
  doi = {10.1038/nature14539}
}`;

describe("paper store", () => {
  it("round-trips records through DATA_DIR/papers/<projectId>.json", async () => {
    const papers = await load();
    expect(papers.readPaperStore("proj1")).toEqual({});

    papers.writePaperRecord("proj1", "lecun2015deep", { summary: "Nets learn.", source: "s2-tldr" });
    papers.writePaperRecord("proj1", "lecun2015deep", { pdfFile: "lecun2015deep.pdf" });

    const store = papers.readPaperStore("proj1");
    expect(store["lecun2015deep"]).toMatchObject({
      summary: "Nets learn.",
      source: "s2-tldr",
      pdfFile: "lecun2015deep.pdf",
    });
    expect(store["lecun2015deep"].updatedAt).toBeTruthy();
    // On disk exactly where promised, isolated per project.
    const raw = JSON.parse(readFileSync(join(dataDir, "papers", "proj1.json"), "utf8"));
    expect(raw["lecun2015deep"].summary).toBe("Nets learn.");
    expect(papers.readPaperStore("proj2")).toEqual({});
  });

  it("sanitizes cite keys for filenames", async () => {
    const papers = await load();
    expect(papers.sanitizeKeyForFile("DBLP:conf/nips/Vaswani17")).toBe("DBLP_conf_nips_Vaswani17");
    expect(papers.sanitizeKeyForFile("plain2020key")).toBe("plain2020key");
    expect(papers.sanitizeKeyForFile("///")).toBe("entry");
  });
});

describe("arxivIdFromEntry", () => {
  it("reads the eprint field, with or without an arXiv: prefix", async () => {
    const papers = await load();
    expect(papers.arxivIdFromEntry({ fields: { eprint: "2106.06935" } })).toBe("2106.06935");
    expect(papers.arxivIdFromEntry({ fields: { eprint: "arXiv:2106.06935v2" } })).toBe("2106.06935v2");
  });

  it("recognizes a 10.48550 arXiv DOI", async () => {
    const papers = await load();
    expect(papers.arxivIdFromEntry({ fields: { doi: "10.48550/arXiv.2106.06935" } })).toBe("2106.06935");
  });

  it("returns undefined otherwise", async () => {
    const papers = await load();
    expect(papers.arxivIdFromEntry({ fields: { doi: "10.1038/nature14539" } })).toBeUndefined();
    expect(papers.arxivIdFromEntry({ fields: {} })).toBeUndefined();
  });
});

describe("getTldr", () => {
  it("prefers the S2 TL;DR and persists it", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        expect(String(url)).toContain("/paper/DOI:");
        return jsonRes(200, {
          title: "Deep learning",
          tldr: { text: "Nets learn features." },
          url: "https://www.semanticscholar.org/paper/x",
          openAccessPdf: { url: "https://oa.example/x.pdf" },
        });
      }),
    );
    const r = await papers.getTldr("proj1", projectDir, "lecun2015deep");
    expect(r).toEqual({ summary: "Nets learn features.", source: "s2-tldr" });
    expect(papers.readPaperStore("proj1")["lecun2015deep"]).toMatchObject({
      summary: "Nets learn features.",
      source: "s2-tldr",
      s2Url: "https://www.semanticscholar.org/paper/x",
      oaPdfUrl: "https://oa.example/x.pdf",
    });
  });

  it("serves the stored summary without touching the network, until forced", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    papers.writePaperRecord("proj1", "lecun2015deep", { summary: "Cached.", source: "s2-tldr" });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network must not be hit");
    }));
    await expect(papers.getTldr("proj1", projectDir, "lecun2015deep")).resolves.toEqual({
      summary: "Cached.",
      source: "s2-tldr",
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { tldr: { text: "Fresh." } })));
    await expect(papers.getTldr("proj1", projectDir, "lecun2015deep", { force: true })).resolves.toEqual({
      summary: "Fresh.",
      source: "s2-tldr",
    });
  });

  it("falls back to the agent condensing the abstract", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { title: "Deep learning", abstract: "Long abstract text." })));
    const summarize = vi.fn(async () => "Two crisp sentences.");
    const r = await papers.getTldr("proj1", projectDir, "lecun2015deep", { summarize });
    expect(r).toEqual({ summary: "Two crisp sentences.", source: "agent" });
    expect(summarize).toHaveBeenCalledWith("Deep learning", "Long abstract text.");
  });

  it("falls back to the abstract verbatim when the agent fails", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { abstract: "The verbatim abstract." })));
    const r = await papers.getTldr("proj1", projectDir, "lecun2015deep", {
      summarize: async () => {
        throw new Error("agent unavailable");
      },
    });
    expect(r).toEqual({ summary: "The verbatim abstract.", source: "abstract" });
  });

  it("uses the bib entry's own abstract when S2 is unreachable", async () => {
    const papers = await load();
    writeBib(`@misc{offline2020, title={Offline Paper}, abstract={Bib abstract.}}`);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const r = await papers.getTldr("proj1", projectDir, "offline2020", {
      summarize: async () => {
        throw new Error("no agent either");
      },
    });
    expect(r).toEqual({ summary: "Bib abstract.", source: "abstract" });
  });

  it("errors clearly when no abstract exists anywhere", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/paper/search")) return jsonRes(200, { data: [] });
      return jsonRes(404, { error: "not found" });
    }));
    await expect(papers.getTldr("proj1", projectDir, "lecun2015deep")).rejects.toThrow(/no abstract available/);
  });

  it("surfaces the rate-limit hint on HTTP 429", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(429, {})));
    await expect(papers.getTldr("proj1", projectDir, "lecun2015deep")).rejects.toThrow(
      /rate limited — add a Semantic Scholar API key in Settings/,
    );
  });

  it("rejects unknown cite keys", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    await expect(papers.getTldr("proj1", projectDir, "ghost2020")).rejects.toThrow(/unknown citation key/);
  });
});

describe("titlesSimilar", () => {
  it("tolerates punctuation and case but rejects different papers", async () => {
    const papers = await load();
    expect(papers.titlesSimilar("Attention is All you Need!", "attention is all you need")).toBe(true);
    expect(papers.titlesSimilar("Deep Learning", "Deep Unlearning of Everything Else")).toBe(false);
  });
});

describe("ensurePaperPdf", () => {
  const ARXIV_ENTRY = `@misc{zhu2021nbfnet,
  title = {Neural Bellman-Ford Networks},
  eprint = {2106.06935},
  archivePrefix = {arXiv}
}`;

  it("downloads the arXiv PDF, caches it, and never re-fetches", async () => {
    const papers = await load();
    writeBib(ARXIV_ENTRY);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("api.semanticscholar.org")) return jsonRes(404, {});
      if (String(url).startsWith("https://arxiv.org/pdf/2106.06935")) return pdfRes();
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const path = await papers.ensurePaperPdf("proj1", projectDir, "zhu2021nbfnet");
    expect(path).toBe(join(dataDir, "papers", "proj1", "zhu2021nbfnet.pdf"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "latin1")).toContain("%PDF-1.4");
    expect(papers.paperPdfPath("proj1", "zhu2021nbfnet")).toBe(path);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network must not be hit");
    }));
    await expect(papers.ensurePaperPdf("proj1", projectDir, "zhu2021nbfnet")).resolves.toBe(path);
  });

  it("rejects HTML masquerading as an open-access PDF", async () => {
    const papers = await load();
    writeBib(`@article{closed2020, title={Closed Paper}, doi={10.1234/closed}}`);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("api.semanticscholar.org")) {
        return jsonRes(200, { openAccessPdf: { url: "https://paywall.example/landing" } });
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("<html>pay us</html>").buffer,
      };
    }));
    await expect(papers.ensurePaperPdf("proj1", projectDir, "closed2020")).rejects.toThrow(
      /no open-access PDF found/,
    );
  });

  it("still serves the arXiv PDF when S2 is rate limited", async () => {
    const papers = await load();
    writeBib(ARXIV_ENTRY);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("api.semanticscholar.org")) return jsonRes(429, {});
      if (String(url).startsWith("https://arxiv.org/pdf/2106.06935")) return pdfRes();
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const path = await papers.ensurePaperPdf("proj1", projectDir, "zhu2021nbfnet");
    expect(existsSync(path)).toBe(true);
  });

  it("surfaces the rate limit when S2 was the only possible source", async () => {
    const papers = await load();
    writeBib(`@article{noarxiv2020, title={No Arxiv Here}, doi={10.1234/x}}`);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(429, {})));
    await expect(papers.ensurePaperPdf("proj1", projectDir, "noarxiv2020")).rejects.toThrow(/rate limited/);
  });

  it("throws NoPdfError when no source is known", async () => {
    const papers = await load();
    writeBib(`@book{knuth1984, title={The TeXbook}}`);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/paper/search")) return jsonRes(200, { data: [] });
      return jsonRes(404, {});
    }));
    await expect(papers.ensurePaperPdf("proj1", projectDir, "knuth1984")).rejects.toThrow(
      /no open-access PDF found/,
    );
  });
});
