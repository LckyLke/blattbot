import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type Command,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  insertCompletionText,
  snippet,
  snippetCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { bibtexLanguage, latexLanguage, latexTags } from "../latex-language";
import { api, type FileContent } from "../api";
import {
  countDrafts,
  dropDraft,
  hasDraft,
  lastOpenFile,
  readDraft,
  reconcileFetched,
  rememberOpenFile,
  stashDraft,
  subscribeDrafts,
} from "../drafts";
import { merge3 } from "../merge3";
import { isFileSaving, notifyEditors, startFileSave, subscribeEditors } from "../editor-sync";
import { useDialog } from "./Dialog";

interface Props {
  projectId: string;
  files: string[];
  mainTex?: string;
  /** Changes when the working tree may have changed — refetches the open file. */
  stamp: number;
  /** True while an agent turn runs — manual editing is disabled then. */
  busy: boolean;
  /** Receives the fresh working diff after a manual save. */
  onDiff: (diff: string) => void;
  /** Called after a successful save — App recompiles when the PDF pane is visible. */
  onSaved?: () => void;
  /** Jump request: select `file`, scroll to `line`, flash it. Fires on `nonce` change. */
  reveal?: { file: string; line: number; nonce: number };
  /** True while a chat pane is on screen to receive a quote. */
  chatVisible?: boolean;
  /** Push a selected passage (with its file/line) into the chat composer. */
  onQuoteToChat?: (text: string, source: string) => void;
  /** A focused editor inside Proof, without the file tree. */
  embedded?: { path: string; line: number };
}

interface DirNode {
  path: string;
  name: string;
  dirs: DirNode[];
  files: { path: string; name: string }[];
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { path: "", name: "", dirs: [], files: [] };
  for (const p of paths) {
    const segs = p.split("/");
    const name = segs.pop()!;
    let cur = root;
    for (const seg of segs) {
      let next = cur.dirs.find((d) => d.name === seg);
      if (!next) {
        next = { path: cur.path ? `${cur.path}/${seg}` : seg, name: seg, dirs: [], files: [] };
        cur.dirs.push(next);
      }
      cur = next;
    }
    cur.files.push({ path: p, name });
  }
  return root;
}

const TEXTISH = /\.(tex|sty|cls|bib|bst|md|txt|csv|dat|json|yml|yaml|toml|log)$/i;
const TEXLIKE = /\.(tex|sty|cls|bib|bst)$/i;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// --- CodeMirror setup -------------------------------------------------------
// The custom LaTeX/BibTeX parsers (latex-language.ts) carry commentTokens
// {line: "%"} (Mod-/ toggling) and the $-pairing/quote-drop closeBrackets
// config in their languageData.

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "var(--color-paper-dim)",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.55",
      overflow: "auto",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      caretColor: "var(--color-paper)",
      padding: "8px 0",
    },
    ".cm-line": { padding: "0 16px 0 12px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-paper)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
      {
        background: "color-mix(in srgb, var(--color-leaf) 25%, transparent)",
      },
    ".cm-gutters": {
      backgroundColor: "var(--color-ink)",
      color: "color-mix(in srgb, var(--color-graphite) 60%, transparent)",
      borderRight: "1px solid var(--color-rule)",
      fontSize: "11px",
      // Line numbers center on the 13px × 1.55 ≈ 20.15px content line box.
      lineHeight: "1.83",
    },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "34px", padding: "0 8px 0 4px" },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--color-ink-3) 40%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--color-ink-3) 40%, transparent)",
      color: "var(--color-paper-dim)",
    },
    ".cm-searchMatch": {
      backgroundColor: "transparent",
      outline: "1px solid var(--color-gold)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "color-mix(in srgb, var(--color-gold) 25%, transparent)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "color-mix(in srgb, var(--color-leaf) 15%, transparent)",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "color-mix(in srgb, var(--color-gold) 15%, transparent)",
      outline: "1px solid color-mix(in srgb, var(--color-gold) 50%, transparent)",
    },
    ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      color: "var(--color-pencil)",
    },
  },
  { dark: true },
);

/** Token colors for the custom LaTeX/BibTeX parsers (latex-language.ts). */
const texHighlight = HighlightStyle.define([
  // Generic \commands and BibTeX @types — gold, the editor's signature accent.
  { tag: [t.keyword, t.tagName], color: "var(--color-gold)" },
  // Sectioning commands are the document's skeleton — softened terracotta
  // (pencil #e06552 warmed toward paper so it reads structural, not angry).
  { tag: latexTags.sectioning, color: "#e0846f", fontWeight: "600" },
  // Environment names (\begin{itemize}) and BibTeX field names.
  { tag: latexTags.envName, color: "var(--color-leaf)" },
  // Cite/ref/label keys and BibTeX entry keys — slate blue: graphite's hue
  // family, lifted. The one cool accent against the warm gold/terracotta.
  { tag: latexTags.refKey, color: "#7ea6c4" },
  // Math content in a pale sage between leaf and paper; delimiters recede.
  { tag: latexTags.math, color: "#a8c090" },
  { tag: latexTags.mathDelim, color: "var(--color-graphite)" },
  // ~, &, \\, #1, \% — noticeable but quiet.
  { tag: latexTags.special, color: "color-mix(in srgb, var(--color-gold) 55%, var(--color-graphite))" },
  { tag: t.comment, color: "var(--color-graphite)", fontStyle: "italic" },
  { tag: [t.bracket, t.paren, t.brace, t.squareBracket], color: "var(--color-graphite)" },
  { tag: t.string, color: "#a8c090" },
  { tag: t.invalid, color: "var(--color-pencil)" },
]);

// --- LaTeX intelligence: autocomplete ---------------------------------------
// Completions live in the editable compartment (suspended while an agent turn
// runs) and only for .tex/.sty/.cls documents. A single override source dispatches on
// the text before the cursor: cite keys inside \cite{…}, label names inside
// \ref{…}, environment names inside \begin{/\end{, and the curated command set
// after a backslash — so context matches never compete with generic commands.

/**
 * [command, snippet template (after the backslash), info, boost].
 * A template makes the completion a snippet: Tab walks its ${} fields and every
 * template ends with an exit stop past the final brace, so Tab always leaves
 * the construct cleanly. Without a template the bare command is inserted.
 */
type CmdDef = [name: string, tpl?: string | null, info?: string, boost?: number];

const GREEK = [
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "rho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi", "chi", "psi",
  "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma",
  "Upsilon", "Phi", "Psi", "Omega",
];

const CMD_DEFS: CmdDef[] = [
  // Document structure
  ["documentclass", "documentclass{${article}}${}", "Set the document class", 1],
  ["usepackage", "usepackage{${}}${}", "Load a package", 2],
  ["input", "input{${}}${}", "Paste in another file's content"],
  ["include", "include{${}}${}", "Include a chapter file (starts a new page)"],
  ["begin", "begin{${env}}\n\t${}\n\\end{${env}}${}", "Open an environment (name is mirrored)", 2],
  ["end", "end{${}}${}", "Close an environment"],
  ["title", "title{${}}${}", "Document title"],
  ["author", "author{${}}${}", "Document author(s), separated by \\and"],
  ["date", "date{${\\today}}${}", "Document date"],
  ["maketitle", null, "Typeset the title block"],
  ["tableofcontents", null, "Insert the table of contents"],
  ["listoffigures"],
  ["listoftables"],
  ["appendix", null, "Switch to appendix numbering"],
  ["newcommand", "newcommand{${\\mycmd}}{${}}${}", "Define a macro"],
  ["renewcommand", "renewcommand{${\\cmd}}{${}}${}", "Redefine a macro"],
  ["newenvironment", "newenvironment{${name}}{${before}}{${after}}${}", "Define an environment"],
  ["newtheorem", "newtheorem{${name}}{${Title}}${}", "Define a theorem-like environment"],
  ["ensuremath", "ensuremath{${}}${}", "Force math mode"],
  // Sectioning
  ["part", "part{${}}${}", "Part heading", 1],
  ["chapter", "chapter{${}}${}", "Chapter heading (book/report)", 1],
  ["section", "section{${}}${}", "Section heading", 3],
  ["subsection", "subsection{${}}${}", "Subsection heading", 2],
  ["subsubsection", "subsubsection{${}}${}", "Subsubsection heading", 1],
  ["paragraph", "paragraph{${}}${}", "Run-in paragraph heading"],
  // Text style
  ["textbf", "textbf{${}}${}", "Bold", 2],
  ["textit", "textit{${}}${}", "Italic", 2],
  ["emph", "emph{${}}${}", "Emphasis (toggles italic)", 2],
  ["texttt", "texttt{${}}${}", "Monospace"],
  ["textsc", "textsc{${}}${}", "Small caps"],
  ["textsf", "textsf{${}}${}", "Sans-serif"],
  ["textrm", "textrm{${}}${}", "Roman (upright)"],
  ["textsl", "textsl{${}}${}", "Slanted"],
  ["underline", "underline{${}}${}"],
  ["textsuperscript", "textsuperscript{${}}${}"],
  ["textsubscript", "textsubscript{${}}${}"],
  ["textcolor", "textcolor{${red}}{${}}${}", "Colored text (xcolor)"],
  ["mbox", "mbox{${}}${}", "Unbreakable horizontal box"],
  ["fbox", "fbox{${}}${}", "Framed box"],
  ["verb", null, "Inline verbatim: \\verb|…|"],
  ["tiny"], ["scriptsize"], ["footnotesize"], ["small"], ["normalsize"],
  ["large"], ["Large"], ["LARGE"], ["huge"], ["Huge"],
  // Labels, references, citations
  ["label", "label{${}}${}", "Name this point for \\ref", 2],
  ["ref", "ref{${}}${}", "Reference a label's number", 2],
  ["eqref", "eqref{${}}${}", "Reference an equation: (n) (amsmath)"],
  ["pageref", "pageref{${}}${}", "Reference a label's page"],
  ["autoref", "autoref{${}}${}", "Typed reference, e.g. “Section 3” (hyperref)"],
  ["nameref", "nameref{${}}${}", "Reference a section's title (hyperref)"],
  ["cref", "cref{${}}${}", "Clever typed reference (cleveref)"],
  ["Cref", "Cref{${}}${}", "Clever reference, capitalized (cleveref)"],
  ["cite", "cite{${}}${}", "Cite a bibliography entry", 2],
  ["citep", "citep{${}}${}", "Parenthetical citation (natbib)"],
  ["citet", "citet{${}}${}", "Textual citation: Author (year) (natbib)"],
  ["citeauthor", "citeauthor{${}}${}", "Author names only"],
  ["citeyear", "citeyear{${}}${}", "Year only"],
  ["autocite", "autocite{${}}${}", "Style-aware citation (biblatex)"],
  ["parencite", "parencite{${}}${}", "Parenthetical citation (biblatex)"],
  ["textcite", "textcite{${}}${}", "Textual citation (biblatex)"],
  ["footcite", "footcite{${}}${}", "Footnote citation (biblatex)"],
  ["nocite", "nocite{${}}${}", "Add to bibliography without citing"],
  ["bibliography", "bibliography{${}}${}", "BibTeX: use .bib file(s)"],
  ["bibliographystyle", "bibliographystyle{${plain}}${}", "BibTeX citation style"],
  ["printbibliography", null, "Print the bibliography (biblatex)"],
  ["addbibresource", "addbibresource{${}}${}", "Register a .bib file (biblatex)"],
  ["footnote", "footnote{${}}${}", "Footnote", 1],
  ["url", "url{${}}${}", "Typeset a URL (url/hyperref)"],
  ["href", "href{${url}}{${text}}${}", "Hyperlink (hyperref)"],
  // Floats, graphics, tables
  ["includegraphics", "includegraphics[width=${\\linewidth}]{${}}${}", "Insert an image (graphicx)", 2],
  ["caption", "caption{${}}${}", "Float caption", 1],
  ["centering", null, "Center content within the float/group"],
  ["graphicspath", "graphicspath{{${}}}${}", "Image search path (graphicx)"],
  ["hline", null, "Horizontal rule (tabular)"],
  ["toprule", null, "Top rule (booktabs)"],
  ["midrule", null, "Middle rule (booktabs)"],
  ["bottomrule", null, "Bottom rule (booktabs)"],
  ["cline", "cline{${2-3}}${}", "Partial horizontal rule (tabular)"],
  ["multicolumn", "multicolumn{${2}}{${c}}{${}}${}", "Span table columns"],
  ["multirow", "multirow{${2}}{${*}}{${}}${}", "Span table rows (multirow)"],
  ["resizebox", "resizebox{${\\textwidth}}{!}{${}}${}", "Scale content (graphicx)"],
  // Math
  ["frac", "frac{${}}{${}}${}", "Fraction", 2],
  ["dfrac", "dfrac{${}}{${}}${}", "Display-style fraction (amsmath)"],
  ["tfrac", "tfrac{${}}{${}}${}", "Text-style fraction (amsmath)"],
  ["sqrt", "sqrt{${}}${}", "Square root", 1],
  ["binom", "binom{${}}{${}}${}", "Binomial coefficient (amsmath)"],
  ["overline", "overline{${}}${}"],
  ["overbrace", "overbrace{${}}^{${}}${}"],
  ["underbrace", "underbrace{${}}_{${}}${}"],
  ["hat", "hat{${}}${}"], ["bar", "bar{${}}${}"], ["vec", "vec{${}}${}"],
  ["tilde", "tilde{${}}${}"], ["dot", "dot{${}}${}"], ["ddot", "ddot{${}}${}"],
  ["mathbf", "mathbf{${}}${}", "Bold math"],
  ["mathit", "mathit{${}}${}", "Italic math"],
  ["mathrm", "mathrm{${}}${}", "Upright math"],
  ["mathcal", "mathcal{${}}${}", "Calligraphic"],
  ["mathbb", "mathbb{${}}${}", "Blackboard bold (amssymb)"],
  ["mathfrak", "mathfrak{${}}${}", "Fraktur (amssymb)"],
  ["boldsymbol", "boldsymbol{${}}${}", "Bold math symbol (amsmath)"],
  ["operatorname", "operatorname{${}}${}", "Upright operator name (amsmath)"],
  ["text", "text{${}}${}", "Text inside math (amsmath)"],
  ["left", null, "Auto-sized opening delimiter"],
  ["right", null, "Auto-sized closing delimiter"],
  ["displaystyle"], ["limits"],
  ["sum", null, "∑"], ["prod", null, "∏"], ["int", null, "∫"], ["oint", null, "∮"],
  ["lim", null, "Limit"], ["infty", null, "∞"], ["partial", null, "∂"], ["nabla", null, "∇"],
  ["cdot", null, "⋅"], ["times", null, "×"], ["pm", null, "±"], ["mp", null, "∓"],
  ["leq", null, "≤"], ["geq", null, "≥"], ["neq", null, "≠"], ["approx", null, "≈"],
  ["equiv", null, "≡"], ["sim", null, "∼"], ["propto", null, "∝"],
  ["subset", null, "⊂"], ["subseteq", null, "⊆"], ["supseteq", null, "⊇"],
  ["in", null, "∈"], ["notin", null, "∉"],
  ["cup", null, "∪"], ["cap", null, "∩"], ["setminus", null, "∖"], ["emptyset", null, "∅"],
  ["forall", null, "∀"], ["exists", null, "∃"], ["neg", null, "¬"],
  ["land", null, "∧"], ["lor", null, "∨"],
  ["rightarrow", null, "→"], ["leftarrow", null, "←"], ["Rightarrow", null, "⇒"],
  ["Leftrightarrow", null, "⇔"], ["mapsto", null, "↦"], ["to", null, "→"],
  ["dots", null, "…"], ["ldots"], ["cdots"], ["vdots"], ["ddots"],
  ["langle", null, "⟨"], ["rangle", null, "⟩"],
  ["lfloor", null, "⌊"], ["rfloor", null, "⌋"], ["lceil", null, "⌈"], ["rceil", null, "⌉"],
  ["prime"], ["circ", null, "∘"], ["bullet"], ["star"],
  ["perp", null, "⊥"], ["parallel", null, "∥"], ["hbar", null, "ℏ"], ["ell", null, "ℓ"],
  // Spacing & breaks
  ["item", null, "List item", 2],
  ["noindent", null, "Suppress paragraph indentation"],
  ["par", null, "Paragraph break"],
  ["newline"],
  ["newpage", null, "Start a new page"],
  ["clearpage", null, "Flush floats, start a new page"],
  ["cleardoublepage"],
  ["pagebreak"], ["linebreak"],
  ["vspace", "vspace{${1em}}${}", "Vertical space"],
  ["hspace", "hspace{${1em}}${}", "Horizontal space"],
  ["vfill", null, "Stretchy vertical fill"],
  ["hfill", null, "Stretchy horizontal fill"],
  ["smallskip"], ["medskip"], ["bigskip"],
  ["quad", null, "1 em space"], ["qquad", null, "2 em space"],
  ["setlength", "setlength{${\\parindent}}{${}}${}", "Set a length register"],
  ["phantom", "phantom{${}}${}", "Invisible spacing copy"],
  ["raggedright"], ["raggedleft"],
  // Misc
  ["LaTeX", null, "The LaTeX logo"], ["TeX"],
  ["today", null, "Current date"],
  ["thanks", "thanks{${}}${}", "Title-page footnote"],
  ["and", null, "Separate authors in \\author"],
  ["textwidth"], ["linewidth"], ["columnwidth"],
];

const COMMAND_COMPLETIONS: Completion[] = [
  ...CMD_DEFS,
  ...GREEK.map((g): CmdDef => [g]),
].map(([name, tpl, info, boost]) => {
  const base: Completion = { label: "\\" + name, type: "keyword" };
  if (info) base.info = info;
  if (boost) base.boost = boost;
  return tpl ? snippetCompletion("\\" + tpl, base) : base;
});

interface EnvDef {
  name: string;
  /** Argument snippet inserted right after \begin{name}. */
  args?: string;
  /** Body template; defaults to one indented empty field. */
  body?: string;
  info?: string;
  boost?: number;
}

const F = "${}"; // a literal snippet field

const ENV_DEFS: EnvDef[] = [
  { name: "document", info: "Top-level document body" },
  { name: "abstract" },
  { name: "itemize", body: "\t\\item " + F, info: "Bulleted list", boost: 2 },
  { name: "enumerate", body: "\t\\item " + F, info: "Numbered list", boost: 2 },
  { name: "description", body: "\t\\item[${term}] " + F, info: "Labeled list" },
  {
    name: "figure",
    args: "[${htbp}]",
    body: "\t\\centering\n\t" + F + "\n\t\\caption{" + F + "}\n\t\\label{fig:" + F + "}",
    info: "Floating figure with caption and label",
    boost: 2,
  },
  {
    name: "table",
    args: "[${htbp}]",
    body: "\t\\centering\n\t" + F + "\n\t\\caption{" + F + "}\n\t\\label{tab:" + F + "}",
    info: "Floating table with caption and label",
    boost: 2,
  },
  { name: "tabular", args: "{${lcr}}", info: "Column layout: l, c, r, |", boost: 1 },
  { name: "tabularx", args: "{${\\textwidth}}{${lX}}", info: "Width-stretching tabular (tabularx)" },
  { name: "equation", info: "Numbered display equation", boost: 2 },
  { name: "equation*", info: "Unnumbered display equation (amsmath)" },
  { name: "align", info: "Aligned equations at & (amsmath)", boost: 2 },
  { name: "align*", info: "Unnumbered aligned equations (amsmath)", boost: 1 },
  { name: "gather" }, { name: "gather*" }, { name: "multline" }, { name: "split" },
  { name: "cases", info: "Piecewise definition (amsmath)", boost: 1 },
  { name: "matrix" }, { name: "pmatrix", info: "Matrix in parentheses", boost: 1 },
  { name: "bmatrix", info: "Matrix in brackets" }, { name: "vmatrix" }, { name: "smallmatrix" },
  { name: "array", args: "{${lcr}}" },
  { name: "center", boost: 1 }, { name: "flushleft" }, { name: "flushright" },
  { name: "quote" }, { name: "quotation" }, { name: "verse" },
  { name: "verbatim", info: "Literal text, no commands" },
  { name: "lstlisting", info: "Code listing (listings)" },
  { name: "minted", args: "{${python}}", info: "Highlighted code (minted)" },
  { name: "algorithm" }, { name: "algorithmic" },
  { name: "theorem", boost: 1 }, { name: "lemma" }, { name: "proposition" },
  { name: "corollary" }, { name: "definition", boost: 1 },
  { name: "proof", boost: 1 }, { name: "remark" }, { name: "example" },
  { name: "frame", args: "{${Title}}", info: "Beamer slide" },
  { name: "tikzpicture", info: "TikZ drawing" },
  { name: "minipage", args: "{${0.5\\textwidth}}" },
  { name: "subfigure", args: "{${0.5\\textwidth}}", info: "Side-by-side figure part (subcaption)" },
  { name: "wrapfigure", args: "{${r}}{${0.4\\textwidth}}", info: "Text-wrapped figure (wrapfig)" },
  { name: "titlepage" },
  { name: "thebibliography", args: "{${99}}", info: "Manual bibliography list" },
];

const ENV_NAMES = ENV_DEFS.map((e) => e.name);

/**
 * \begin{…} completion: replaces the partial name (and the auto-closed `}` if
 * present) with a snippet — args, an indented body field, and the matching
 * \end, ending on an exit stop so Tab steps body → out.
 */
function applyBeginEnv(def: EnvDef) {
  const tpl =
    def.name + "}" + (def.args ?? "") + "\n" + (def.body ?? "\t" + F) + "\n\\end{" + def.name + "}" + F;
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
    snippet(tpl)(view, completion, from, end);
  };
}

const BEGIN_ENV_OPTIONS: Completion[] = ENV_DEFS.map((def) => {
  const opt: Completion = { label: def.name, type: "type", apply: applyBeginEnv(def) };
  if (def.info) opt.info = def.info;
  if (def.boost) opt.boost = def.boost;
  return opt;
});

/** \end{…} completion: plain name, consuming an auto-closed `}`. */
function applyEndEnv(name: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
    view.dispatch(insertCompletionText(view.state, name + "}", from, end));
  };
}

// Any command containing "cite" (cite/citep/citet/autocite/parencite/textcite/
// footcite/nocite/…), optional args, cursor inside the key braces.
const CITE_CTX = /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/;
const REF_CTX = /\\(?:ref|eqref|pageref|autoref|nameref|vref|Vref|cref|Cref|labelcref|cpageref)\*?\{([^{}]*)$/;
const ENV_CTX = /\\(begin|end)\s*\{([A-Za-z*@]*)$/;
// The backslash must not itself be escaped (\\ is a line break, not a command).
const CMD_CTX = /(^|[^\\])\\([a-zA-Z]*)$/;

/** Both \cite{a,b,…} and \cref{a,b}: complete the segment after the last comma. */
function segmentFrom(pos: number, listText: string): number {
  const seg = listText.slice(listText.lastIndexOf(",") + 1);
  return pos - seg.replace(/^\s*/, "").length;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The innermost still-open \begin{…} above pos (for ranking \end{ options). */
function openEnvironment(state: EditorState, pos: number): string | null {
  const text = state.sliceDoc(Math.max(0, pos - 20000), pos);
  const stack: string[] = [];
  for (const m of text.matchAll(/\\(begin|end)\s*\{([^{}]*)\}/g)) {
    if (m[1] === "begin") stack.push(m[2]);
    else {
      const i = stack.lastIndexOf(m[2]);
      if (i >= 0) stack.splice(i, 1);
    }
  }
  return stack[stack.length - 1] ?? null;
}

/** Is the \begin{env} just before pos already balanced by an \end{env} below? */
function envClosedAfter(state: EditorState, pos: number, env: string): boolean {
  const text = state.sliceDoc(pos, Math.min(state.doc.length, pos + 50000));
  const re = new RegExp("\\\\(begin|end)\\s*\\{" + escapeRe(env) + "\\}", "g");
  let depth = 0;
  for (const m of text.matchAll(re)) {
    if (m[1] === "begin") depth++;
    else if (--depth < 0) return true;
  }
  return false;
}

/**
 * Refinement: Enter at the end of a hand-typed `\begin{env}` line inserts the
 * matching \end{env} below and puts the cursor on an indented line between —
 * the forgotten \end is the most common LaTeX compile error. Only fires when
 * that \begin is not already balanced further down.
 */
const insertEnvClose: Command = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const col = sel.head - line.from;
  if (line.text.slice(col).trim()) return false;
  const m = /\\begin\s*\{([^{}]+)\}(?:\{[^{}]*\}|\[[^\]]*\])*\s*$/.exec(line.text.slice(0, col));
  if (!m || envClosedAfter(state, sel.head, m[1])) return false;
  const base = /^\s*/.exec(line.text)![0];
  const unit = state.facet(indentUnit);
  view.dispatch({
    changes: { from: sel.head, insert: `\n${base}${unit}\n${base}\\end{${m[1]}}` },
    selection: { anchor: sel.head + 1 + base.length + unit.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

interface CompletionData {
  path: () => string | null;
  bib: () => { key: string; title: string | null; year: string | null }[];
  labels: () => { name: string; file: string; line: number }[];
}

function makeLatexSource(data: CompletionData): CompletionSource {
  return (context) => {
    if (!/\.(tex|sty|cls)$/i.test(data.path() ?? "")) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);

    const cite = CITE_CTX.exec(before);
    if (cite) {
      const options = data.bib().map(
        (e): Completion => ({
          label: e.key,
          type: "constant",
          detail:
            [e.title && clip(e.title, 48), e.year && `(${e.year})`].filter(Boolean).join(" ") ||
            undefined,
        }),
      );
      if (!options.length) return null;
      return { from: segmentFrom(context.pos, cite[1]), options, validFor: /^[^\s,{}]*$/ };
    }

    const ref = REF_CTX.exec(before);
    if (ref) {
      const here = data.path();
      const options = data.labels().map(
        (l): Completion => ({
          label: l.name,
          type: "variable",
          detail: `${l.file}:${l.line}`,
          boost: l.file === here ? 1 : 0,
        }),
      );
      if (!options.length) return null;
      return { from: segmentFrom(context.pos, ref[1]), options, validFor: /^[^\s,{}]*$/ };
    }

    const env = ENV_CTX.exec(before);
    if (env) {
      const from = context.pos - env[2].length;
      if (env[1] === "begin") {
        return { from, options: BEGIN_ENV_OPTIONS, validFor: /^[A-Za-z*@]*$/ };
      }
      const open = openEnvironment(context.state, from);
      const names = open && !ENV_NAMES.includes(open) ? [...ENV_NAMES, open] : ENV_NAMES;
      return {
        from,
        options: names.map(
          (n): Completion => ({
            label: n,
            type: "type",
            apply: applyEndEnv(n),
            boost: n === open ? 99 : 0,
          }),
        ),
        validFor: /^[A-Za-z*@]*$/,
      };
    }

    const cmd = CMD_CTX.exec(before);
    if (cmd) {
      return {
        from: context.pos - cmd[2].length - 1,
        options: COMMAND_COMPLETIONS,
        validFor: /^\\[a-zA-Z]*$/,
      };
    }
    // Explicit Ctrl+Space mid-word (no backslash yet) still offers commands.
    if (context.explicit) {
      const word = /[a-zA-Z]*$/.exec(before)![0];
      return {
        from: context.pos - word.length,
        options: COMMAND_COMPLETIONS,
        validFor: /^\\?[a-zA-Z]*$/,
      };
    }
    return null;
  };
}

// Reveal flash: a line decoration toggled by a StateEffect, cleared on a timer.
const setFlash = StateEffect.define<number | null>();
const flashLine = Decoration.line({ class: "cm-flash-line" });
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        deco = e.value === null ? Decoration.none : Decoration.set([flashLine.range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const editableExt = (on: boolean, complete: CompletionSource): Extension =>
  on
    ? [
        closeBrackets(),
        autocompletion({ override: [complete], activateOnTyping: true }),
        // Registered before defaultKeymap/indentWithTab, so: Tab accepts an
        // open completion (falls through to indent otherwise — and while
        // snippet fields are active, the snippet's own Prec.highest Tab
        // binding wins and walks the fields), Enter auto-closes a hand-typed
        // \begin{…}. Escape/arrows/Enter-to-accept and the explicit
        // Ctrl+Space trigger come with autocompletion()'s default keymap.
        keymap.of([
          { key: "Tab", run: acceptCompletion },
          { key: "Enter", run: insertEnvClose },
        ]),
      ]
    : [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        // Non-editable content is not focusable by default — keep it focusable
        // so search (Mod-f), selection, and copy still work while the agent
        // holds the working tree (`busy`).
        EditorView.contentAttributes.of({ tabindex: "0" }),
      ];

const WRAP_KEY = "blattbot.sourceWrap";
const AUTOSAVE_KEY = "blattbot.sourceAutosave";
/** Idle time after the last keystroke before an autosave (when enabled). */
const AUTOSAVE_MS = 1500;
const CONFLICT_MARK = "<<<<<<< yours";

/**
 * Nonce of the last reveal request acted on. Module-level on purpose: the
 * panel remounts on a pane swap, and a remount must not re-run a jump that
 * already happened (it would override the remembered file and flash a line).
 */
let handledRevealNonce = -1;

export default function SourcePanel({ projectId, files, mainTex, stamp, busy, onDiff, onSaved, reveal, chatVisible, onQuoteToChat, embedded }: Props) {
  const dialog = useDialog();
  const tree = useMemo(() => buildTree(files), [files]);
  const [sel, setSel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  /** The server copy of the open file moved under an unsaved draft. */
  const [diskChanged, setDiskChanged] = useState(false);
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === "1");
  /** Opt-in: write the file after AUTOSAVE_MS of idle typing. */
  const [autosave, setAutosave] = useState(() => localStorage.getItem(AUTOSAVE_KEY) === "1");
  const [cursor, setCursor] = useState({ line: 1, col: 1, lines: 1 });

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Content as last fetched from / saved to the server for the open file. */
  const savedRef = useRef("");
  /** Path of the document currently loaded into the editor. */
  const docPathRef = useRef<string | null>(null);
  const pendingReveal = useRef<{ file: string; line: number } | null>(null);
  const editorId = useRef(Symbol("editor")).current;
  const receiving = useRef(false);

  const busyRef = useRef(busy);
  busyRef.current = busy;
  const projRef = useRef(projectId);
  projRef.current = projectId;
  const wrapRef = useRef(wrap);
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const selRef = useRef(sel);
  selRef.current = sel;
  const saveRef = useRef<() => void>(() => {});
  const onDiffRef = useRef(onDiff);
  onDiffRef.current = onDiff;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Compartments survive state re-creation; reconfigured on toggle.
  const comp = useRef({ editable: new Compartment(), wrap: new Compartment() }).current;

  // Re-render when a draft appears or disappears (tree dots, own dirty dot).
  const draftCount = useSyncExternalStore(subscribeDrafts, () => countDrafts(projectId));

  // The instance survives a project switch (same tree position); its per-file
  // state must not — a stale `sel` would fetch the OLD project's file from
  // the new one. Drafts are stashed per project, so nothing is lost here.
  const prevProjectRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectRef.current === projectId) return;
    prevProjectRef.current = projectId;
    docPathRef.current = null;
    savedRef.current = "";
    setSel(null);
    setFile(null);
    setError(null);
    setDirty(false);
    setSaveErr(null);
    setDiskChanged(false);
  }, [projectId]);

  // Autocomplete data, cached in refs — the CodeMirror source reads them
  // synchronously mid-keystroke. Fetched on mount, refreshed on stamp changes
  // (the working tree may have gained labels or bib entries).
  const bibRef = useRef<{ key: string; title: string | null; year: string | null }[]>([]);
  const labelsRef = useRef<{ name: string; file: string; line: number }[]>([]);
  useEffect(() => {
    let stale = false;
    api
      .refs(projectId)
      .then((r) => {
        if (!stale) bibRef.current = r.entries.map((e) => ({ key: e.key, title: e.title, year: e.year }));
      })
      .catch(() => {});
    api
      .labels(projectId)
      .then((r) => {
        if (!stale) labelsRef.current = r.labels;
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [projectId, stamp]);

  const completionSource = useMemo(
    () =>
      makeLatexSource({
        path: () => docPathRef.current,
        bib: () => bibRef.current,
        labels: () => labelsRef.current,
      }),
    [],
  );

  const updateListener = useMemo(
    () =>
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          // The stash mirrors the editor: present exactly while the text
          // differs from the last fetched/saved content (see drafts.ts).
          const text = u.state.doc.toString();
          const isDirty = text !== savedRef.current;
          setDirty(isDirty);
          const path = docPathRef.current;
          if (path && !receiving.current) {
            // A draft keeps the base it started from (a merge needs it);
            // only a fresh draft takes the current disk content as base.
            if (isDirty) {
              const base = readDraft(projRef.current, path)?.base ?? savedRef.current;
              stashDraft(projRef.current, path, { content: text, base });
            } else dropDraft(projRef.current, path);
            notifyEditors({
              projectId: projRef.current, path, origin: editorId,
              kind: "document", content: text, saved: savedRef.current,
            });
          }
          if (isDirty && !receiving.current) armAutosave();
        }
        if (u.docChanged || u.selectionSet) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          setCursor({ line: line.number, col: head - line.from + 1, lines: u.state.doc.lines });
        }
      }),
    [],
  );

  const buildState = useCallback(
    (content: string, path: string) =>
      EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          search(),
          indentUnit.of("  "),
          // Mirrored snippet fields (\begin{env}…\end{env}) edit several
          // ranges at once; drawSelection (above) renders them.
          EditorState.allowMultipleSelections.of(true),
          editorTheme,
          syntaxHighlighting(texHighlight),
          flashField,
          /\.bib$/i.test(path) ? bibtexLanguage : TEXLIKE.test(path) ? latexLanguage : [],
          comp.editable.of(editableExt(!busyRef.current, completionSource)),
          comp.wrap.of(wrapRef.current ? EditorView.lineWrapping : []),
          // Before the default bindings: Mod-s saves, Mod-g goes to a line.
          keymap.of([
            {
              key: "Mod-s",
              // IDE-style quick save: write + recompile, keep typing.
              run: () => {
                saveRef.current();
                return true;
              },
            },
            { key: "Mod-g", run: gotoLine },
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          updateListener,
        ],
      }),
    [comp, updateListener, completionSource],
  );

  // One editor instance for the panel's lifetime; documents swap via setState.
  useEffect(() => {
    const view = new EditorView({ state: buildState("", ""), parent: hostRef.current! });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Both panes can show the same file. Mirror edits, undo and saves without
  // creating a second draft or moving the other editor's cursor to EOF.
  useEffect(() => subscribeEditors((update) => {
    if (update.origin === editorId || update.projectId !== projRef.current ||
        update.path !== docPathRef.current) return;
    if (update.kind === "saving") {
      savingRef.current = update.saving;
      setSaving(update.saving);
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    savedRef.current = update.saved;
    const current = view.state.doc.toString();
    const next = update.content;
    if (current !== next) {
      let from = 0;
      while (from < current.length && from < next.length && current[from] === next[from]) from++;
      let end = 0;
      while (end < current.length - from && end < next.length - from &&
             current[current.length - end - 1] === next[next.length - end - 1]) end++;
      receiving.current = true;
      try {
        view.dispatch({ changes: { from, to: current.length - end, insert: next.slice(from, next.length - end) } });
      } finally {
        receiving.current = false;
      }
    }
    setDirty(next !== update.saved);
    setDiskChanged(next !== update.saved && readDraft(update.projectId, update.path)?.base !== update.saved);
    setSaveErr(null);
  }), [editorId]);

  const applyPendingReveal = useCallback((view: EditorView) => {
    const p = pendingReveal.current;
    if (!p || docPathRef.current !== p.file) return;
    pendingReveal.current = null;
    const doc = view.state.doc;
    const ln = Math.max(1, Math.min(p.line, doc.lines));
    const pos = doc.line(ln).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: [EditorView.scrollIntoView(pos, { y: "center" }), setFlash.of(pos)],
    });
    view.focus();
    // File switches also reset the status readout. Keep the navigation's
    // destination authoritative even when the editor was just re-created.
    setCursor({ line: ln, col: 1, lines: doc.lines });
    window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: setFlash.of(null) });
    }, 1300);
  }, []);

  /**
   * Autosave: an idle-timer save. Never while the agent holds the tree or a
   * save is in flight (save() refuses those; the finally below re-arms), and
   * never with unresolved merge conflict markers in the text — a manual save
   * is the user's explicit decision there.
   */
  const armAutosave = useCallback(() => {
    if (!autosaveRef.current) return;
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const view = viewRef.current;
      if (!view || !autosaveRef.current) return;
      const text = view.state.doc.toString();
      if (text === savedRef.current || text.includes(CONFLICT_MARK)) return;
      saveRef.current();
    }, AUTOSAVE_MS);
  }, []);
  useEffect(() => () => clearTimeout(autosaveTimer.current), []);
  useEffect(() => {
    localStorage.setItem(AUTOSAVE_KEY, autosave ? "1" : "0");
    if (autosave) armAutosave();
    else clearTimeout(autosaveTimer.current);
  }, [autosave, armAutosave]);

  const save = useCallback(async () => {
    const view = viewRef.current;
    const path = selRef.current;
    if (!view || !path || savingRef.current || busyRef.current) return;
    const content = view.state.doc.toString();
    if (content === savedRef.current) return; // clean doc — nothing to save
    const finishSave = startFileSave(projectId, path, editorId);
    if (!finishSave) return;
    let live = content;
    const stopTracking = subscribeEditors((update) => {
      if (update.kind === "document" && update.projectId === projectId && update.path === path) {
        live = update.content;
      }
    });
    savingRef.current = true;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await api.saveFile(projectId, path, content);
      // The draft is shared: it also includes typing in the other pane and
      // survives closing this editor or selecting a different file mid-save.
      if (live !== content) stashDraft(projectId, path, { content: live, base: content });
      else dropDraft(projectId, path);
      if (projRef.current === projectId && docPathRef.current === path) {
        savedRef.current = content;
        setFile((f) => (f ? { ...f, content, size: new TextEncoder().encode(content).length } : f));
        // Quick save keeps the editor live: whatever was typed during the
        // round-trip is still a draft, over the content just written.
        setDirty(live !== content);
        setDiskChanged(false);
      }
      notifyEditors({ projectId, path, origin: editorId, kind: "document", content: live, saved: content });
      onDiffRef.current(res.diff);
      onSavedRef.current?.();
    } catch (err: any) {
      setSaveErr(err.message);
    } finally {
      stopTracking();
      finishSave();
      savingRef.current = false;
      setSaving(false);
      // Typed on during the round-trip: the idle timer picks it up again.
      if (view.state.doc.toString() !== savedRef.current) armAutosave();
    }
  }, [projectId, armAutosave, editorId]);
  saveRef.current = save;

  /**
   * Three-way merge of the draft with the disk version (merge3.ts): base is
   * what the draft was typed over, ours the editor, theirs the disk. Regions
   * only one side touched merge silently; both-sides regions that differ are
   * written as git-style conflict blocks, and the first one is revealed.
   */
  function mergeWithDisk() {
    const view = viewRef.current;
    const path = selRef.current;
    if (!view || !path) return;
    const ours = view.state.doc.toString();
    const theirs = savedRef.current;
    const base = readDraft(projectId, path)?.base ?? theirs;
    const { text, conflicts } = merge3(base, ours, theirs);
    if (text !== ours) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }
    // The merged text is now relative to the disk version.
    if (text !== theirs) stashDraft(projectId, path, { content: text, base: theirs });
    else dropDraft(projectId, path);
    setDirty(text !== theirs);
    setDiskChanged(false);
    notifyEditors({ projectId, path, origin: editorId, kind: "document", content: text, saved: theirs });
    if (conflicts > 0) {
      setSaveErr(
        `${conflicts} conflict${conflicts === 1 ? "" : "s"} marked ${CONFLICT_MARK} … >>>>>>> disk — resolve them, then save`,
      );
      const at = text.indexOf(CONFLICT_MARK);
      if (at >= 0) {
        view.dispatch({
          selection: { anchor: at },
          effects: [EditorView.scrollIntoView(at, { y: "center" }), setFlash.of(at)],
        });
        window.setTimeout(() => viewRef.current?.dispatch({ effects: setFlash.of(null) }), 1300);
      }
    } else {
      setSaveErr(null);
    }
  }

  const confirmDiscard = () =>
    dialog.confirm({
      title: "Discard unsaved changes?",
      body: "This file has unsaved edits — leaving it now throws them away.",
      confirmLabel: "Discard changes",
      danger: true,
    });

  /** Drop the unsaved draft (confirmed) and restore the last-saved content. */
  async function revert() {
    if (!(await confirmDiscard())) return;
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== savedRef.current) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: savedRef.current } });
    }
    if (sel) dropDraft(projectId, sel);
    setDirty(false);
    setSaveErr(null);
    setDiskChanged(false);
  }

  /**
   * Open another file. An unsaved draft stays stashed (and marked in the
   * tree) rather than demanding a discard: a jump from the chat or the
   * Proof view must not cost the user their edits.
   */
  function selectFile(path: string) {
    if (path === sel) return;
    setSaveErr(null);
    rememberOpenFile(projectId, path);
    setSel(path);
  }

  // Pick a file once the list is known: the one open before (a remount after
  // a pane swap, a project re-entered), else the main file, else the first
  // text-like one. Also recovers if the open file disappears.
  useEffect(() => {
    if (embedded) {
      if (sel !== embedded.path) {
        pendingReveal.current = { file: embedded.path, line: embedded.line };
        setSel(embedded.path);
      }
      return;
    }
    if (files.length === 0) return;
    if (sel && files.includes(sel)) return;
    const remembered = lastOpenFile(projectId);
    const pick =
      remembered && files.includes(remembered)
        ? remembered
        : mainTex && files.includes(mainTex)
          ? mainTex
          : (files.find((f) => TEXTISH.test(f)) ?? files[0]);
    rememberOpenFile(projectId, pick);
    setSel(pick);
  }, [files, mainTex, sel, projectId, embedded]);

  useEffect(() => {
    if (!sel) {
      setFile(null);
      return;
    }
    let stale = false;
    api
      .file(projectId, sel)
      .then((f) => {
        if (!stale) {
          setFile(f);
          setError(null);
        }
      })
      .catch((err) => {
        if (!stale) {
          setFile(null);
          setError(err.message);
        }
      });
    return () => {
      stale = true;
    };
  }, [projectId, sel, stamp]);

  // Sync the fetched file into the editor: fresh state on file switch (with
  // a stashed draft restored), in-place content replace (scroll/selection
  // preserved) on refetch — but never over text the user typed.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !file || file.binary) return;
    const pid = projRef.current;
    if (docPathRef.current !== file.path) {
      docPathRef.current = file.path;
      savingRef.current = isFileSaving(pid, file.path);
      setSaving(savingRef.current);
      savedRef.current = file.content;
      const draft = readDraft(pid, file.path);
      const restore = draft && draft.content !== file.content ? draft : undefined;
      if (draft && !restore) dropDraft(pid, file.path); // the disk caught up with it
      view.setState(buildState(restore ? restore.content : file.content, file.path));
      setDirty(Boolean(restore));
      // The draft keeps the base it was typed over — a three-way merge needs
      // it when the disk moved meanwhile (that is what diskChanged means).
      setDiskChanged(Boolean(restore) && restore!.base !== file.content);
      setCursor({ line: 1, col: 1, lines: view.state.doc.lines });
      applyPendingReveal(view);
      return;
    }
    const current = view.state.doc.toString();
    const prevBase = savedRef.current;
    const r = reconcileFetched(current, prevBase, file.content);
    savedRef.current = file.content;
    if (r.action === "replace") {
      if (current !== file.content) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
      }
      dropDraft(pid, file.path);
      setDirty(false);
      setDiskChanged(false);
    } else {
      setDirty(r.dirty);
      if (r.dirty) {
        // Keep the base the draft started from (never re-base a live draft).
        const base = readDraft(pid, file.path)?.base ?? prevBase;
        stashDraft(pid, file.path, { content: current, base });
        setDiskChanged(base !== file.content);
      } else {
        dropDraft(pid, file.path);
        setDiskChanged(false);
      }
    }
    applyPendingReveal(view);
  }, [file, buildState, applyPendingReveal]);

  // Busy swap: readOnly while an agent turn runs, editable otherwise. The
  // compartment reconfigure leaves the document alone, so an unsaved draft
  // survives the round-trip.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: comp.editable.reconfigure(editableExt(!busy, completionSource)),
    });
  }, [busy, comp, completionSource]);

  // Wrap toggle, persisted.
  useEffect(() => {
    wrapRef.current = wrap;
    localStorage.setItem(WRAP_KEY, wrap ? "1" : "0");
    viewRef.current?.dispatch({
      effects: comp.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap, comp]);

  // Reveal requests: select the file (a draft in the current one stays
  // stashed), then jump once loaded.
  useEffect(() => {
    if (!reveal || reveal.nonce === handledRevealNonce) return;
    handledRevealNonce = reveal.nonce;
    pendingReveal.current = { file: reveal.file, line: reveal.line };
    if (reveal.file !== selRef.current) {
      setSaveErr(null);
      rememberOpenFile(projRef.current, reveal.file);
      setSel(reveal.file);
    } else if (viewRef.current && docPathRef.current === reveal.file) {
      applyPendingReveal(viewRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  function renderDir(node: DirNode, depth: number): ReactNode {
    const pad = { paddingLeft: `${10 + depth * 12}px` };
    return (
      <div key={node.path || "root"}>
        {node.path && (
          <button
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            style={pad}
            className="flex w-full items-center gap-1 py-1 pr-2 text-left text-[11.5px] text-paper-dim hover:text-paper"
          >
            <span className="text-[9px] text-graphite">{collapsed.has(node.path) ? "▸" : "▾"}</span>
            <span className="truncate">{node.name}/</span>
          </button>
        )}
        {(!node.path || !collapsed.has(node.path)) && (
          <>
            {node.dirs.map((d) => renderDir(d, node.path ? depth + 1 : depth))}
            {node.files.map((f) => (
              <button
                key={f.path}
                onClick={() => void selectFile(f.path)}
                style={{ paddingLeft: `${10 + (node.path ? depth + 1 : depth) * 12}px` }}
                className={`flex w-full items-baseline gap-1.5 py-1 pr-2 text-left font-mono text-[11.5px] transition-colors ${
                  sel === f.path ? "bg-ink-3 text-paper" : "text-paper-dim hover:bg-ink-3/50"
                }`}
              >
                <span className="truncate">{f.name}</span>
                {f.path !== sel && hasDraft(projectId, f.path) && (
                  <span className="text-gold" title="Unsaved edits">
                    ●
                  </span>
                )}
                {f.path === mainTex && (
                  <span className="rounded-sm border border-gold/40 px-1 text-[8.5px] uppercase tracking-wide text-gold">
                    main
                  </span>
                )}
              </button>
            ))}
          </>
        )}
      </div>
    );
  }

  const showEditor = file !== null && !file.binary && !error;
  void draftCount; // subscription keeps the tree's draft dots current

  // A finished selection inside the editor offers a "quote in chat" chip —
  // the Source twin of the PDF panel's chip (same wording and placement), and
  // only while a chat pane is on screen to receive it.
  const [quoteChip, setQuoteChip] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    if (!chatVisible || !onQuoteToChat) setQuoteChip(null);
  }, [chatVisible, onQuoteToChat]);

  const onEditorMouseUp = useCallback(() => {
    if (!chatVisible || !onQuoteToChat) return;
    setTimeout(() => {
      const host = hostRef.current;
      const sel = window.getSelection();
      if (!host || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString();
      if (!text.trim()) return;
      const range = sel.getRangeAt(sel.rangeCount - 1);
      const anchorEl =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      if (!anchorEl || !host.contains(anchorEl)) return;
      const rects = range.getClientRects();
      const r = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      const wrap = host.parentElement!.getBoundingClientRect();
      setQuoteChip({
        x: Math.min(Math.max(r.right - wrap.left, 8), Math.max(8, wrap.width - 130)),
        y: Math.min(Math.max(r.bottom - wrap.top + 8, 8), Math.max(8, wrap.height - 40)),
        text,
      });
    }, 0);
  }, [chatVisible, onQuoteToChat]);

  useEffect(() => {
    if (!quoteChip) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-quote-chip]")) setQuoteChip(null);
    };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setQuoteChip(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [quoteChip]);

  return (
    <div className="flex h-full">
      {!embedded && <aside className="w-48 shrink-0 overflow-y-auto border-r border-rule py-1.5">
        {files.length === 0 ? (
          <p className="px-3 py-2 text-xs text-graphite">No files.</p>
        ) : (
          renderDir(tree, 0)
        )}
      </aside>}

      <div className="flex min-w-0 flex-1 flex-col">
        {sel && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-rule px-4 py-1">
            <span className="truncate font-mono text-[11.5px] text-paper-dim">
              {sel}
              {dirty && <span className="ml-1.5 align-middle text-gold">●</span>}
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {saveErr && <span className="text-[11px] text-pencil">{saveErr}</span>}
              {dirty && diskChanged && (
                <span
                  className="rounded border border-pencil/40 bg-pencil/10 px-1.5 py-px text-[10.5px] text-pencil"
                  title="This file changed on disk (an agent turn, a sync, or a rejected hunk) while you were editing. Save writes your version over it; Revert drops your edits and shows the disk version."
                >
                  changed on disk
                </span>
              )}
              {dirty && diskChanged && !busy && (
                <button
                  onClick={mergeWithDisk}
                  disabled={saving}
                  title="Three-way merge: keep your edits and the disk changes together; passages both changed differently are marked as conflicts"
                  className="rounded border border-rule px-2 py-0.5 text-[11.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                >
                  Merge
                </button>
              )}
              {file && !file.binary && (
                <>
                  {busy && (
                    <span className="rounded border border-gold/30 bg-gold/10 px-1.5 py-px text-[10.5px] text-gold">
                      read-only while the agent works
                    </span>
                  )}
                  {dirty && (
                    <button
                      onClick={() => void revert()}
                      disabled={saving}
                      title="Discard the unsaved draft and restore the saved file"
                      className="rounded border border-rule px-2 py-0.5 text-[11.5px] text-paper-dim transition-colors hover:border-pencil hover:text-pencil disabled:opacity-50"
                    >
                      Revert
                    </button>
                  )}
                  <button
                    onClick={() => void save()}
                    disabled={!dirty || saving || busy}
                    className="rounded bg-leaf-deep px-2.5 py-0.5 text-[11.5px] font-medium text-paper transition-colors hover:bg-leaf disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </>
              )}
            </span>
          </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-hidden bg-ink" onMouseUp={onEditorMouseUp}>
          <div ref={hostRef} data-editor="codemirror" className={showEditor ? "h-full" : "hidden"} />
          {quoteChip && (
            <button
              type="button"
              data-quote-chip
              style={{ left: quoteChip.x, top: quoteChip.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const text = quoteChip.text;
                setQuoteChip(null);
                // Name the file so the agent can locate the passage exactly.
                const line = sel && viewRef.current
                  ? viewRef.current.state.doc.lineAt(
                      Math.min(
                        viewRef.current.state.selection.main.from,
                        viewRef.current.state.doc.length,
                      ),
                    ).number
                  : undefined;
                const where = sel ? `${sel}${line ? `:${line}` : ""}` : "the source";
                const trimmed = text.length > 600 ? `${text.slice(0, 600).trimEnd()}…` : text;
                onQuoteToChat?.(trimmed, where);
              }}
              className="absolute z-20 rounded-full border border-rule bg-ink-2/95 px-2.5 py-1 text-[11.5px] text-paper-dim shadow-[0_2px_10px_rgba(0,0,0,0.45)] transition-colors hover:border-leaf hover:text-leaf"
            >
              ❝ quote in chat
            </button>
          )}
          {error && <p className="px-4 py-6 text-center text-sm text-pencil">{error}</p>}
          {file?.binary && (
            <p className="px-4 py-8 text-center font-serif text-sm text-graphite">
              Binary file · {fmtSize(file.size)}
            </p>
          )}
          {!sel && !error && (
            <p className="px-4 py-8 text-center font-serif text-sm text-graphite">
              Select a file to view its source.
            </p>
          )}
        </div>

        {showEditor && (
          <div className="flex shrink-0 items-center gap-3 border-t border-rule px-3 py-[3px] font-mono text-[10.5px] text-graphite">
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span>{cursor.lines} lines</span>
            <span>{fmtSize(file.size)}</span>
            <button
              onClick={() => setAutosave((a) => !a)}
              aria-pressed={autosave}
              title="Autosave: write the file 1.5 s after you stop typing (never while the agent works, never with unresolved conflict markers)"
              className={`ml-auto rounded border px-1.5 py-px transition-colors ${
                autosave
                  ? "border-leaf/60 text-leaf"
                  : "border-rule text-graphite hover:border-leaf/40 hover:text-paper-dim"
              }`}
            >
              autosave
            </button>
            <button
              onClick={() => setWrap((w) => !w)}
              aria-pressed={wrap}
              title="Toggle line wrapping"
              className={`rounded border px-1.5 py-px transition-colors ${
                wrap
                  ? "border-leaf/60 text-leaf"
                  : "border-rule text-graphite hover:border-leaf/40 hover:text-paper-dim"
              }`}
            >
              wrap
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
