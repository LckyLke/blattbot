/** Isolated, reusable demo project. Uses public papers and the configured Codex login.
 * Run with --prepare to retrieve sources and perform real evidence checks before recording.
 * No private project data, fabricated model replies or fabricated citation edges.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const demoRoot = process.env.DEMO_DATA_DIR ?? join(tmpdir(), "blattbot-site-demo");
process.env.BLATTBOT_DATA_DIR = demoRoot;
const cfg = await import("../src/config.js");
const git = await import("../src/git.js");
const paperDir = join(demoRoot, "sources");
mkdirSync(paperDir, { recursive: true });
export const papers = [
  { key: "devlin2019", doi: "10.18653/v1/n19-1423", arxiv: "1810.04805", title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", author: "Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina", year: "2019" },
  { key: "raffel2020", doi: "10.48550/arxiv.1910.10683", arxiv: "1910.10683", title: "Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer", author: "Raffel, Colin and others", year: "2020" },
];
export const manuscript = String.raw`\documentclass[11pt]{article}
\usepackage[a4paper,margin=28mm]{geometry}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage{hyperref}
\hypersetup{colorlinks=true,linkcolor=black,citecolor=blue,urlcolor=blue}
\title{From Attention to Transfer Learning}
\author{Research notebook}
\date{}
\begin{document}
\maketitle
\begin{abstract}
This working review compares how language models represent context and
transfer what they learn. We organize the literature by architecture,
training objective and evaluation setting.
\end{abstract}

\section{Evidence before comparison}
T5 casts language tasks into a common text-to-text format~\cite{raffel2020}.

BERT pretrains bidirectional representations using context from both
directions~\cite{devlin2019}.

\section{A plan for related work}
Our review separates three questions: how context is represented,
which pretraining objective is used, and how transfer is evaluated.
For each paper, we will record the original evidence and its limitations
before drafting the comparison.

\section{Questions to resolve}
\textbf{Draft claim to check:} One architecture is best for every language task.

Which comparisons use the same datasets and metrics?
Which findings require a closer reading of the original paper?

\bibliographystyle{plain}
\bibliography{references}
\end{document}
`;
export const project = cfg.listProjects().find(p => p.name === "Attention & Transfer Learning") ?? cfg.addProject({
  name: "Attention & Transfer Learning", kind: "local", gitUrl: "", mainTex: "main.tex", contextPaths: [paperDir],
});
export const projectPath = cfg.projectDir(project.id);
mkdirSync(projectPath, { recursive: true });
if (!existsSync(join(demoRoot, "fixture-v2"))) {
  writeFileSync(join(projectPath, "main.tex"), manuscript);
  writeFileSync(join(projectPath, "references.bib"), papers.map(p => `@article{${p.key},\n  title={${p.title}},\n  author={${p.author}},\n  year={${p.year}},\n  doi={${p.doi}},\n  eprint={${p.arxiv}},\n  archivePrefix={arXiv},\n  url={https://arxiv.org/abs/${p.arxiv}}\n}\n`).join("\n"));
  if (!existsSync(join(projectPath, ".git"))) await git.initRepo(projectPath);
  await git.commitAll(projectPath, "Start the literature review");
  writeFileSync(join(demoRoot, "fixture-v2"), "2");
}

if (process.argv.includes("--prepare")) {
  const fetched = await Promise.allSettled(papers.map(async paper => {
    const path = join(paperDir, `${paper.key}.pdf`);
    if (existsSync(path)) return;
    const response = await fetch(`https://arxiv.org/pdf/${paper.arxiv}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Paper download: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Paper endpoint did not return a PDF");
    writeFileSync(path, bytes);
    console.log(`Downloaded ${paper.title}`);
  }));
  for (const result of fetched) if (result.status === "rejected") throw result.reason;
  const { compileProject } = await import("../src/compile.js");
  const compile = await compileProject(project.id, projectPath, "main.tex");
  if (!compile.ok || !existsSync(join(demoRoot, "builds", project.id, "main.pdf"))) throw new Error(`Manuscript compile failed: ${JSON.stringify(compile.errors)}`);
  console.log("Compiled manuscript.");
  const { readGraph, buildGraph } = await import("../src/research/graph.js");
  const { libraryStatus, indexPaper } = await import("../src/research/library.js");
  const { evidenceView, verifyClaim } = await import("../src/research/evidence.js");
  const { strictReport, auditUncitedClaims } = await import("../src/research/strict.js");
  const preparation = await Promise.allSettled([
    (async () => {
      if (readGraph(project.id, projectPath).pendingKeys.length) await buildGraph(project.id, projectPath);
      const graph = readGraph(project.id, projectPath);
      if (graph.pendingKeys.length || !graph.edges.length) throw new Error(`Graph is incomplete: ${JSON.stringify(graph.errors)}`);
      console.log(`Retrieved citation graph: ${graph.nodes.length} works, ${graph.edges.length} citations.`);
    })(),
    (async () => {
      for (const key of libraryStatus(project.id, projectPath).pending) await indexPaper(project.id, projectPath, key);
      console.log("Full-text library indexed.");
      for (const claim of evidenceView(project.id, projectPath)) if (["unchecked", "stale"].includes(claim.status)) {
        const evidence = await verifyClaim(project.id, projectPath, claim.id);
        console.log(`Real evidence assessment for ${claim.key}: ${evidence.verdict}`);
      }
      if (!strictReport(project.id, projectPath).auditCurrent) await auditUncitedClaims(project.id, projectPath);
      console.log("Real uncited-assertion audit saved.");
    })(),
  ]);
  for (const [i, result] of preparation.entries()) if (result.status === "rejected") console.error(`Preparation ${i}:`, result.reason);
  if (preparation.some(r => r.status === "rejected")) process.exit(1);
  writeFileSync(join(demoRoot, "provenance.json"), JSON.stringify({ recordedWith: "Actual BlattBot UI", sources: papers.map(p => `https://arxiv.org/abs/${p.arxiv}`), graph: "OpenAlex, retrieved through BlattBot", judgments: "Real model checks, prepared before recording", modelSettings: "Uses the default Codex CLI configuration", preparedAt: new Date().toISOString(), projectId: project.id }, null, 2));
  console.log(`READY ${demoRoot}`);
}
