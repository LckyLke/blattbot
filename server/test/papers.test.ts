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
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

/** A minimal, real single-page PDF whose content stream is exactly `text` — pdfjs-dist can read it back. */
function makeTextPdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/** Buffer.from() often returns a view into a pooled ArrayBuffer — .buffer alone would include the whole slab. */
const textPdfRes = (text: string) => {
  const buf = makeTextPdf(text);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
};

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

  it("falls back to OpenAlex's abstract when S2 is rate limited", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes("api.semanticscholar.org")) return jsonRes(429, {});
        if (u.includes("api.openalex.org/works/doi:")) {
          return jsonRes(200, {
            display_name: "Deep learning",
            abstract_inverted_index: { Deep: [0], nets: [1], learn: [2], features: [3] },
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const summarize = vi.fn(async () => "Condensed via OpenAlex.");
    const r = await papers.getTldr("proj1", projectDir, "lecun2015deep", { summarize });
    expect(r).toEqual({ summary: "Condensed via OpenAlex.", source: "agent" });
    expect(summarize).toHaveBeenCalledWith("Deep learning", "Deep nets learn features");
  });

  it("rejects unknown cite keys", async () => {
    const papers = await load();
    writeBib(DOI_ENTRY);
    await expect(papers.getTldr("proj1", projectDir, "ghost2020")).rejects.toThrow(/unknown citation key/);
  });
});

describe("s2Get rate-limit pacing", () => {
  // resolveS2Paper tries DOI, then arXiv, then title — up to three sequential
  // calls for one entry when the earlier ones 404. A personal key's
  // introductory limit is 1 req/sec, so firing all three back-to-back can
  // 429 even with a perfectly valid key unless they are paced apart.
  const PACED_ENTRY = { fields: { doi: "10.1234/paced", eprint: "2106.06935", title: "Paced Paper" } };

  it("paces sequential lookups ~1.1s apart once a personal key is set", async () => {
    const { saveSettings } = await import("../src/settings.js");
    saveSettings({ s2ApiKey: "test-key" });
    const papers = await load();
    const callTimes: number[] = [];
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          callTimes.push(Date.now());
          return jsonRes(404, {});
        }),
      );
      const result = papers.resolveS2Paper(PACED_ENTRY);
      await vi.advanceTimersByTimeAsync(4000);
      await result;
    } finally {
      vi.useRealTimers();
    }
    expect(callTimes.length).toBe(3);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(1100);
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1100);
  });

  it("does not pace requests when no key is configured — the shared pool isn't a per-caller quota", async () => {
    const papers = await load();
    const callTimes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callTimes.push(Date.now());
        return jsonRes(404, {});
      }),
    );
    await papers.resolveS2Paper(PACED_ENTRY);
    expect(callTimes.length).toBe(3);
    expect(callTimes[2] - callTimes[0]).toBeLessThan(500);
  });
});

describe("titlesSimilar", () => {
  it("tolerates punctuation and case but rejects different papers", async () => {
    const papers = await load();
    expect(papers.titlesSimilar("Attention is All you Need!", "attention is all you need")).toBe(true);
    expect(papers.titlesSimilar("Deep Learning", "Deep Unlearning of Everything Else")).toBe(false);
  });
});

describe("resolveOpenAlexPaper", () => {
  it("looks up by DOI first and reconstructs the abstract from the inverted index", async () => {
    const papers = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        expect(String(url)).toContain("/works/doi:10.1038%2Fnature14539");
        return jsonRes(200, {
          display_name: "Deep learning",
          // Out-of-order positions, and a repeated word — the join must respect position, not iteration order.
          abstract_inverted_index: { the: [0, 4], quick: [1], fox: [2, 5], jumps: [3] },
          best_oa_location: { pdf_url: "https://oa.example/deep.pdf" },
        });
      }),
    );
    const result = await papers.resolveOpenAlexPaper({ fields: { doi: "10.1038/nature14539" } });
    expect(result).toEqual({
      title: "Deep learning",
      abstract: "the quick fox jumps the fox",
      oaUrl: "https://oa.example/deep.pdf",
    });
  });

  it("falls back to a title search verified by similarity when there is no DOI", async () => {
    const papers = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        expect(String(url)).toContain("works?search=");
        return jsonRes(200, {
          results: [{ display_name: "Attention Is All You Need", open_access: { oa_url: "https://oa.example/attn.pdf" } }],
        });
      }),
    );
    const result = await papers.resolveOpenAlexPaper({ fields: { title: "Attention is all you need" } });
    expect(result?.oaUrl).toBe("https://oa.example/attn.pdf");
  });

  it("rejects a title-search hit whose title does not match", async () => {
    const papers = await load();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { results: [{ display_name: "A Completely Different Paper" }] })));
    const result = await papers.resolveOpenAlexPaper({ fields: { title: "Attention is all you need" } });
    expect(result).toBeNull();
  });

  it("returns null without throwing when OpenAlex is unreachable and there is no title to fall back on", async () => {
    const papers = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(papers.resolveOpenAlexPaper({ fields: { doi: "10.1038/nature14539" } })).resolves.toBeNull();
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

  it("falls back to OpenAlex's OA link when S2 is rate limited and there is no arXiv id", async () => {
    const papers = await load();
    writeBib(`@article{closed2021, title={A Closed Paper}, doi={10.1234/closed2021}}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes("api.semanticscholar.org")) return jsonRes(429, {});
        if (u.includes("api.openalex.org/works/doi:")) {
          return jsonRes(200, {
            display_name: "A Closed Paper",
            open_access: { oa_url: "https://oa.example/closed2021.pdf" },
          });
        }
        if (u.startsWith("https://oa.example/closed2021.pdf")) return pdfRes();
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const path = await papers.ensurePaperPdf("proj1", projectDir, "closed2021");
    expect(existsSync(path)).toBe(true);
    expect(papers.readPaperStore("proj1")["closed2021"]).toMatchObject({
      oaPdfUrl: "https://oa.example/closed2021.pdf",
    });
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

describe("verifyCitationSupport", () => {
  const ARXIV_ENTRY = `@misc{zhu2021nbfnet,
  title = {Neural Bellman-Ford Networks},
  eprint = {2106.06935},
  archivePrefix = {arXiv}
}`;

  it("reads the cached PDF's actual text and asks the judge with it", async () => {
    const papers = await load();
    writeBib(ARXIV_ENTRY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes("api.semanticscholar.org")) return jsonRes(404, {});
        if (u.startsWith("https://arxiv.org/pdf/2106.06935")) {
          return textPdfRes("NBFNet generalizes Bellman-Ford to learn link representations end-to-end.");
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const judge = vi.fn(async (prompt: string) => "SUPPORTED\nThe extracted text says exactly this.");
    const result = await papers.verifyCitationSupport(
      "proj1",
      projectDir,
      "zhu2021nbfnet",
      "NBFNet learns link representations end-to-end.",
      { judge },
    );
    expect(result).toEqual({
      verdict: "supported",
      explanation: "The extracted text says exactly this.",
      basis: "full_text",
    });
    expect(judge).toHaveBeenCalledTimes(1);
    const prompt = judge.mock.calls[0][0] as string;
    expect(prompt).toContain("NBFNet generalizes Bellman-Ford to learn link representations end-to-end.");
    expect(prompt).toContain("NBFNet learns link representations end-to-end.");
    expect(prompt).toContain("full text of the cited paper");
  });

  it("falls back to the abstract when no open-access PDF exists", async () => {
    const papers = await load();
    writeBib(`@article{closed2020, title={Closed Paper}, doi={10.1234/closed}, abstract={We show X causes Y in all cases tested.}}`);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/paper/search")) return jsonRes(200, { data: [] });
      return jsonRes(404, {});
    }));
    const judge = vi.fn(async (prompt: string) => "PARTIALLY_SUPPORTED\nThe abstract hedges more than the claim does.");
    const result = await papers.verifyCitationSupport(
      "proj1",
      projectDir,
      "closed2020",
      "X always causes Y.",
      { judge },
    );
    expect(result).toEqual({
      verdict: "partially_supported",
      explanation: "The abstract hedges more than the claim does.",
      basis: "abstract",
    });
    const prompt = judge.mock.calls[0][0] as string;
    expect(prompt).toContain("We show X causes Y in all cases tested.");
    expect(prompt).toContain("abstract only");
  });

  it("returns unclear without calling the judge when neither a PDF nor an abstract exists", async () => {
    const papers = await load();
    writeBib(`@book{knuth1984, title={The TeXbook}}`);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/paper/search")) return jsonRes(200, { data: [] });
      return jsonRes(404, {});
    }));
    const judge = vi.fn(async () => "SUPPORTED\nshould never be reached");
    const result = await papers.verifyCitationSupport("proj1", projectDir, "knuth1984", "Any claim.", { judge });
    expect(result.verdict).toBe("unclear");
    expect(result.explanation).toMatch(/no open-access pdf or abstract/i);
    expect(judge).not.toHaveBeenCalled();
  });

  it("recognizes NOT_SUPPORTED distinctly from SUPPORTED despite the substring overlap", async () => {
    const papers = await load();
    writeBib(`@article{closed2020, title={Closed Paper}, doi={10.1234/closed}, abstract={Unrelated content.}}`);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(404, {})));
    const judge = vi.fn(async () => "Verdict: NOT_SUPPORTED\nThe abstract never mentions this.");
    const result = await papers.verifyCitationSupport("proj1", projectDir, "closed2020", "Some claim.", { judge });
    expect(result.verdict).toBe("not_supported");
  });
});

describe("formatCitationCheckResult", () => {
  it("tells the agent to act on a NOT_SUPPORTED verdict", async () => {
    const papers = await load();
    const out = papers.formatCitationCheckResult("smith2020", "The claim.", {
      verdict: "not_supported",
      explanation: "The paper says the opposite.",
      basis: "full_text",
    });
    expect(out).toContain("NOT SUPPORTED");
    expect(out).toContain("checked against the full paper text");
    expect(out).toContain("Do not leave this as-is");
  });

  it("leaves a supported verdict without a corrective instruction", async () => {
    const papers = await load();
    const out = papers.formatCitationCheckResult("smith2020", "The claim.", {
      verdict: "supported",
      explanation: "Directly stated in section 4.",
      basis: "abstract",
    });
    expect(out).toContain("SUPPORTED");
    expect(out).toContain("checked against the abstract only");
    expect(out).not.toContain("Do not leave this as-is");
  });
});

describe("verifyAllCitations", () => {
  function writeTex(name: string, content: string) {
    writeFileSync(join(projectDir, name), content);
  }

  it("checks each cited entry against its first citation site and skips unused entries", async () => {
    const papers = await load();
    writeBib(
      [
        `@article{used1,`,
        `  title = {Used One},`,
        `  doi = {10.1/one},`,
        `  abstract = {First entry abstract.}`,
        `}`,
        ``,
        `@article{used2,`,
        `  title = {Used Two},`,
        `  doi = {10.1/two},`,
        `  abstract = {Second entry abstract.}`,
        `}`,
        ``,
        `@article{unused,`,
        `  title = {Unused},`,
        `  doi = {10.1/three},`,
        `  abstract = {Never cited.}`,
        `}`,
      ].join("\n"),
    );
    writeTex(
      "main.tex",
      [
        "Some intro text.",
        "",
        "Transformers scale well \\cite{used1} on long sequences.",
        "",
        "Later, the same idea reappears \\cite{used1} again.",
        "",
        "A second finding \\cite{used2} about something else.",
      ].join("\n"),
    );
    // No PDF/S2/OpenAlex record for any of these — every entry falls back to
    // its own bib abstract, which is already on hand with no further fetch.
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(404, {})));
    const judge = vi.fn(async (prompt: string) =>
      prompt.includes("Second entry abstract") ? "NOT_SUPPORTED\nDoesn't match." : "SUPPORTED\nMatches.",
    );

    const audit = await papers.verifyAllCitations("proj1", projectDir, { judge, delayMs: 0 });

    expect(Object.keys(audit.results).sort()).toEqual(["used1", "used2"]);
    expect(audit.skipped).toEqual(["unused"]);
    expect(audit.results["used1"]).toMatchObject({
      verdict: "supported",
      basis: "abstract",
      file: "main.tex",
      line: 3,
      claim: "Transformers scale well \\cite{used1} on long sequences.",
    });
    expect(audit.results["used2"].verdict).toBe("not_supported");
    // A second, later occurrence of used1 is not re-checked.
    expect(judge).toHaveBeenCalledTimes(2);
    // Persisted so the report survives a reload.
    expect(papers.readClaimAudit("proj1")).toEqual(audit);
  });

  it("skips every entry when nothing in the project is cited", async () => {
    const papers = await load();
    writeBib(`@article{lonely, title = {Lonely}, doi = {10.1/lonely}}`);
    const judge = vi.fn(async () => "SUPPORTED\nshould never run");
    const audit = await papers.verifyAllCitations("proj1", projectDir, { judge, delayMs: 0 });
    expect(audit.results).toEqual({});
    expect(audit.skipped).toEqual(["lonely"]);
    expect(judge).not.toHaveBeenCalled();
  });

  it("returns null from readClaimAudit before any sweep has run", async () => {
    const papers = await load();
    expect(papers.readClaimAudit("never-run")).toBeNull();
  });
});
