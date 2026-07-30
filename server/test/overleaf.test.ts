import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { zipSync } from "fflate";
import { OverleafClient, parseProjectUrl } from "../src/overleaf/olclient.js";
import { parseNameStatus, unpackZip } from "../src/overleaf/olsync.js";

describe("parseProjectUrl", () => {
  it("parses overleaf.com editor links", () => {
    expect(parseProjectUrl("https://www.overleaf.com/project/5f1b2c3d4e5f6a7b8c9d0e1f")).toEqual({
      baseUrl: "https://www.overleaf.com",
      projectId: "5f1b2c3d4e5f6a7b8c9d0e1f",
    });
  });

  it("parses self-hosted instance links", () => {
    expect(parseProjectUrl("https://overleaf.uni-paderborn.de/project/6a38f942205a91b533c318be")).toEqual({
      baseUrl: "https://overleaf.uni-paderborn.de",
      projectId: "6a38f942205a91b533c318be",
    });
  });

  it("tolerates trailing paths, queries, and whitespace", () => {
    expect(parseProjectUrl("  https://ol.example.org/project/6a38f942205a91b533c318be?x=1#detacher \n")).toMatchObject({
      projectId: "6a38f942205a91b533c318be",
    });
  });

  it("rejects git URLs and non-project links", () => {
    expect(parseProjectUrl("https://git.overleaf.com/6a38f942205a91b533c318be")).toBeNull();
    expect(parseProjectUrl("https://overleaf.example.org/login")).toBeNull();
    expect(parseProjectUrl("https://overleaf.example.org/project/not-a-hex-id")).toBeNull();
    expect(parseProjectUrl("not a url at all")).toBeNull();
  });
});

describe("listProjects", () => {
  let server: Server;
  let base: string;
  let dashboardHtml = "";

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(dashboardHtml);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () => new OverleafClient(base, "overleaf_session2=x");

  it("parses the prefetched blob with entity-encoded JSON and flags", async () => {
    const blob = JSON.stringify({
      totalSize: 3,
      projects: [
        { id: "5f1b2c3d4e5f6a7b8c9d0e1f", name: 'Q&A "quotes"', lastUpdated: "2026-07-29T10:00:00Z" },
        { _id: "6a38f942205a91b533c318be", name: "Old-style id", archived: true },
        { id: "not-hex", name: "bogus" },
      ],
    })
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
    dashboardHtml = `<html><head><meta name="ol-prefetchedProjectsBlob" content="${blob}"></head></html>`;
    const projects = await client().listProjects();
    expect(projects).toEqual([
      {
        id: "5f1b2c3d4e5f6a7b8c9d0e1f",
        name: 'Q&A "quotes"',
        lastUpdated: "2026-07-29T10:00:00Z",
        archived: false,
        trashed: false,
      },
      {
        id: "6a38f942205a91b533c318be",
        name: "Old-style id",
        lastUpdated: undefined,
        archived: true,
        trashed: false,
      },
    ]);
  });

  it("tolerates attributes between name and content (real instances render data-type)", async () => {
    // Verified against overleaf.uni-paderborn.de: JSON metas look like
    // <meta name="ol-prefetchedProjectsBlob" data-type="json" content="...">
    const blob = JSON.stringify({
      projects: [{ id: "6a38f942205a91b533c318be", name: "CE Thesis" }],
    }).replace(/"/g, "&quot;");
    dashboardHtml = `<html><head><meta name="ol-prefetchedProjectsBlob" data-type="json" content="${blob}"></head></html>`;
    const projects = await client().listProjects();
    expect(projects.map((p) => p.name)).toEqual(["CE Thesis"]);
  });

  it("falls back to the older ol-projects array meta", async () => {
    const blob = JSON.stringify([{ _id: "6a38f942205a91b533c318be", name: "CE project" }]).replace(
      /"/g,
      "&quot;",
    );
    dashboardHtml = `<html><head><meta name="ol-projects" content="${blob}"></head></html>`;
    const projects = await client().listProjects();
    expect(projects.map((p) => p.name)).toEqual(["CE project"]);
  });

  it("throws a clear error when no project list is present", async () => {
    dashboardHtml = "<html><head><title>Overleaf</title></head></html>";
    await expect(client().listProjects()).rejects.toThrow(/project list/i);
  });
});

describe("unpackZip", () => {
  it("round-trips files and skips directory entries and traversal", () => {
    const zip = Buffer.from(
      zipSync({
        "main.tex": new TextEncoder().encode("\\documentclass{article}"),
        "chapters/ch1.tex": new TextEncoder().encode("\\section{One}"),
        "chapters/": new Uint8Array(0),
        "../evil.txt": new TextEncoder().encode("nope"),
      }),
    );
    const files = unpackZip(zip);
    expect(files.get("main.tex")?.toString()).toBe("\\documentclass{article}");
    expect(files.get("chapters/ch1.tex")?.toString()).toBe("\\section{One}");
    expect([...files.keys()].some((k) => k.includes(".."))).toBe(false);
  });
});

describe("parseNameStatus", () => {
  it("maps added/modified/deleted to a push plan", () => {
    const plan = parseNameStatus("M\tmain.tex\nA\treferences.bib\nD\told.tex\n");
    expect(plan).toEqual([
      { status: "upload", path: "main.tex" },
      { status: "upload", path: "references.bib" },
      { status: "delete", path: "old.tex" },
    ]);
  });

  it("expands renames into delete + upload", () => {
    const plan = parseNameStatus("R100\tintro.tex\tchapters/intro.tex\n");
    expect(plan).toEqual([
      { status: "delete", path: "intro.tex" },
      { status: "upload", path: "chapters/intro.tex" },
    ]);
  });

  it("handles empty diffs", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("\n")).toEqual([]);
  });
});
