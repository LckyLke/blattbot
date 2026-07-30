/**
 * Hand-rolled LaTeX + BibTeX stream parsers for the source editor.
 *
 * The legacy stex mode lumps nearly everything into two tags, so documents
 * rendered as one accent color plus comments. These parsers emit a genuinely
 * differentiated token set — sectioning commands, environment names, cite/ref
 * keys, math regions, special characters — as custom @lezer/highlight tags.
 * SourcePanel's HighlightStyle assigns the actual colors.
 */
import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { Tag, tags as t } from "@lezer/highlight";

/**
 * Custom tags, each parented on a standard tag so a generic fallback
 * highlighter still renders something sane if a style forgets to map them.
 */
export const latexTags = {
  /** \section, \chapter, … — the document's skeleton. */
  sectioning: Tag.define(t.heading),
  /** Environment names inside \begin{…}/\end{…}, and BibTeX field names. */
  envName: Tag.define(t.typeName),
  /** Keys inside \cite{…}/\ref{…}/\label{…}, and BibTeX entry keys. */
  refKey: Tag.define(t.labelName),
  /** Content of $…$ / $$…$$ / \[…\] / \(…\) math regions. */
  math: Tag.define(t.string),
  /** The math delimiters themselves. */
  mathDelim: Tag.define(t.bracket),
  /** ~, &, #1-style params, and single-character escapes like \% or \\. */
  special: Tag.define(t.escape),
};

/** Resolves the custom token names returned by the token() functions below. */
const tokenTable = {
  command: t.tagName, // generic \commands and BibTeX @types — gold, as before
  sectioning: latexTags.sectioning,
  envName: latexTags.envName,
  refKey: latexTags.refKey,
  math: latexTags.math,
  mathDelim: latexTags.mathDelim,
  special: latexTags.special,
};

// --- LaTeX ------------------------------------------------------------------

const SECTIONING = /^(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?$/;
/** Commands whose brace argument is a key: the \cite family, \ref family, \label. */
const KEY_COMMANDS =
  /^(?:label|(?:page|auto|name|eq)?ref|[vV]ref|[cC]ref|labelcref|cpageref|[a-zA-Z]*[cC]ite[a-zA-Z]*)\*?$/;
/** Environments whose body renders plain (best-effort verbatim tracking). */
const VERBATIM_ENVS = /^(?:verbatim\*?|lstlisting|minted|alltt|[BLV]?Verbatim)$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const verbCloseCache = new Map<string, RegExp>();
function verbatimCloseRe(name: string): RegExp {
  let re = verbCloseCache.get(name);
  if (!re) {
    re = new RegExp("^\\\\end\\s*\\{" + escapeRe(name) + "\\}");
    verbCloseCache.set(name, re);
  }
  return re;
}

interface TexState {
  /** Open math region: "$", "$$" or "\\[" (also used for \( … \)). */
  math: "$" | "$$" | "\\[" | null;
  /** The next brace group holds an environment name or a ref/cite key. */
  pending: "env" | "key" | null;
  /** Whether the pending env argument belongs to \begin (verbatim tracking). */
  begin: boolean;
  /** Kind of the special brace group we're inside, with its brace depth. */
  argKind: "env" | "key" | null;
  argDepth: number;
  /** Environment name collected inside a \begin/\end argument. */
  envName: string;
  /** Inside a \begin{verbatim}-style body: its exact name; plain until \end. */
  verbatim: string | null;
  /** The next token is \verb's delimited argument. */
  verbArg: boolean;
}

function texToken(stream: StringStream, state: TexState): string | null {
  // Verbatim bodies render plain until their exact \end{name}.
  if (state.verbatim) {
    if (stream.match(verbatimCloseRe(state.verbatim), false)) {
      state.verbatim = null; // fall through: the \end{…} parses normally
    } else {
      stream.next();
      if (!stream.skipTo("\\")) stream.skipToEnd();
      return null;
    }
  }

  // \verb|…| — one delimited argument, plain (a $ inside must not open math).
  if (state.verbArg) {
    state.verbArg = false;
    const delim = stream.next();
    if (delim && delim !== " ") {
      while (!stream.eol()) if (stream.next() === delim) break;
    }
    return null;
  }

  if (stream.eatSpace()) return null;

  // Comments win everywhere outside verbatim (escaped \% never reaches here —
  // the backslash branch below consumes it as a single token).
  if (stream.peek() === "%") {
    stream.skipToEnd();
    return "comment";
  }

  // Inside \cite{…}/\ref{…}/\begin{…}: keys and environment names.
  if (state.argDepth > 0) {
    const ch = stream.next()!;
    if (ch === "{") {
      state.argDepth++;
      return "bracket";
    }
    if (ch === "}") {
      state.argDepth--;
      if (state.argDepth === 0) {
        const name = state.envName.trim();
        if (state.argKind === "env" && state.begin && VERBATIM_ENVS.test(name)) {
          state.verbatim = name;
        }
        state.argKind = null;
      }
      return "bracket";
    }
    if (ch === ",") return null; // list separators (\cite{a,b}) stay plain
    if (ch === "\\") {
      stream.match(/^[a-zA-Z@]+/); // rare: a command inside the argument
      return "command";
    }
    stream.eatWhile(/[^{}\\,%]/);
    if (state.argKind === "env") {
      state.envName += stream.current();
      return "envName";
    }
    return "refKey";
  }

  // A command expecting a special argument was just seen: `{` opens it, one
  // optional [·] group is skipped, anything else cancels the expectation.
  if (state.pending) {
    if (stream.eat("{")) {
      state.argKind = state.pending;
      state.argDepth = 1;
      state.pending = null;
      state.envName = "";
      return "bracket";
    }
    if (stream.match(/^\[[^\]]*\]/)) return null; // e.g. \cite[p.~3]{…}
    state.pending = null;
  }

  const ch = stream.next()!;

  if (ch === "\\") {
    if (stream.match(/^[a-zA-Z@]+/)) {
      stream.eat("*");
      const name = stream.current().slice(1);
      if (name === "begin" || name === "end") {
        state.pending = "env";
        state.begin = name === "begin";
        return "command";
      }
      if (SECTIONING.test(name)) return "sectioning";
      if (KEY_COMMANDS.test(name)) {
        state.pending = "key";
        return "command";
      }
      if (name === "verb" || name === "verb*") {
        state.verbArg = true;
        return "command";
      }
      return "command";
    }
    // Control symbol: \% \$ \{ \& \\ … — one token, must not flip any state.
    const c = stream.next();
    if (c === "[") {
      state.math = "\\[";
      return "mathDelim";
    }
    if (c === "(") {
      state.math = "$";
      return "mathDelim";
    }
    if (c === "]" || c === ")") {
      state.math = null;
      return "mathDelim";
    }
    return "special";
  }

  if (ch === "$") {
    const dbl = stream.eat("$");
    state.math = state.math ? null : dbl ? "$$" : "$";
    return "mathDelim";
  }

  if (ch === "{" || ch === "}" || ch === "[" || ch === "]") return "bracket";
  if (ch === "&" || ch === "~") return "special";
  if (ch === "#") {
    stream.match(/^\d+/); // macro parameter #1
    return "special";
  }

  // Plain prose (or math content) up to the next interesting character.
  stream.eatWhile(/[^\\$%{}[\]&~#]/);
  return state.math ? "math" : null;
}

const latexParser: StreamParser<TexState> = {
  name: "latex",
  startState: () => ({
    math: null,
    pending: null,
    begin: false,
    argKind: null,
    argDepth: 0,
    envName: "",
    verbatim: null,
    verbArg: false,
  }),
  copyState: (s) => ({ ...s }),
  token: texToken,
  blankLine(state) {
    // Safety valve: an unmatched $ or { must not poison the rest of the file.
    // Math can't span a paragraph break in TeX anyway; verbatim bodies can,
    // so that state survives.
    state.math = null;
    state.pending = null;
    state.argKind = null;
    state.argDepth = 0;
    state.verbArg = false;
  },
  languageData: {
    commentTokens: { line: "%" }, // Mod-/ toggling
    // LaTeX-tuned auto-closing: `$` pairs (inline math is the most-typed
    // LaTeX delimiter; it only closes at non-word boundaries, so apostrophes
    // in prose stay untouched) and the default `'`/`"` pairing is dropped —
    // LaTeX quoting is ``…'' and auto-closed quotes fight it.
    closeBrackets: { brackets: ["(", "[", "{", "$"] },
  },
  tokenTable,
};

/** LaTeX language for .tex/.sty/.cls (and .bst, best-effort). */
export const latexLanguage = StreamLanguage.define(latexParser);

// --- BibTeX -----------------------------------------------------------------

interface BibState {
  /** Between @type and its closing brace/paren. */
  inEntry: boolean;
  /** Brace/paren depth inside the entry (1 = the field level). */
  depth: number;
  /** The first bare word at depth 1 is the entry key. */
  expectKey: boolean;
}

function bibToken(stream: StringStream, state: BibState): string | null {
  if (stream.eatSpace()) return null;
  const ch = stream.peek();

  if (!state.inEntry) {
    if (ch === "%") {
      // Not officially BibTeX syntax, but the universal editor convention.
      stream.skipToEnd();
      return "comment";
    }
    if (ch === "@") {
      stream.next();
      stream.eatWhile(/[a-zA-Z]/);
      state.inEntry = true;
      state.depth = 0;
      // @string's "key" position is a field name; @comment/@preamble have none.
      state.expectKey = !/^@(?:comment|preamble|string)$/i.test(stream.current());
      return "command";
    }
    // Anything between entries is a comment to BibTeX — leave it plain.
    stream.next();
    stream.eatWhile(/[^@%]/);
    return null;
  }

  if (ch === "{" || ch === "(") {
    stream.next();
    state.depth++;
    return "bracket";
  }
  if (ch === "}" || ch === ")") {
    stream.next();
    if (--state.depth <= 0) {
      state.inEntry = false;
      state.depth = 0;
    }
    return "bracket";
  }
  if (state.depth === 0) {
    // @type seen but no opening brace — anything else aborts the entry.
    state.inEntry = false;
    stream.next();
    return null;
  }
  if (ch === ",") {
    stream.next();
    return null;
  }
  if (state.depth === 1) {
    if (stream.match(/^[^\s=,{}()]+(?=\s*=)/)) return "envName"; // field name
    if (state.expectKey && stream.match(/^[^\s,{}()]+/)) {
      state.expectKey = false;
      return "refKey"; // the citation key — same hue as \cite{…} arguments
    }
  }
  // Values, numbers, `=`, quoted strings — plain prose.
  stream.next();
  stream.eatWhile(/[^,{}()\s]/);
  return null;
}

const bibtexParser: StreamParser<BibState> = {
  name: "bibtex",
  startState: () => ({ inEntry: false, depth: 0, expectKey: false }),
  copyState: (s) => ({ ...s }),
  token: bibToken,
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
  },
  tokenTable,
};

/** BibTeX language for .bib files. */
export const bibtexLanguage = StreamLanguage.define(bibtexParser);
