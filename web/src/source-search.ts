import { EditorState } from "@codemirror/state";
import { type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
/**
 * The query the editor runs for one find.
 *
 * LaTeX wraps prose over several source lines, so a phrase the reader sees as
 * one line can hold a line break. A literal search therefore sends each run of
 * whitespace as `\s+`: one typed space matches a space, a line break, or the
 * indentation after it. A regular-expression search stays exactly as typed.
 */
export function sourceSearchQuery(options: {
  search: string;
  replace?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
}): SearchQuery {
  const { search, replace = "", caseSensitive = false, wholeWord = false, regexp = false } = options;
  if (regexp || !/\s/.test(search))
    return new SearchQuery({ search, replace, caseSensitive, wholeWord, regexp, literal: !regexp });
  return new SearchQuery({
    search: search.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&").replace(/\s+/g, "\\s+"),
    // The replacement now runs through the regular-expression path, where "$"
    // starts a group reference. Escape it to keep the typed text literal.
    replace: replace.replace(/\$/g, "$$$$"),
    caseSensitive,
    wholeWord,
    regexp: true,
    literal: true,
  });
}

/** Compact editor-native search. Literal LaTeX, live counts, and safe read-only replacement controls. */
export function sourceSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-search blattbot-source-search";
  const main = document.createElement("div");
  main.className = "source-find-row";
  const search = document.createElement("input");
  search.type = "text";
  search.setAttribute("main-field", "true");
  search.setAttribute("aria-label", "Find in source");
  search.placeholder = "Find in source…";
  const count = document.createElement("span");
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  const button = (label: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-label", title);
    b.title = title;
    b.onclick = run;
    return b;
  };
  const previous = button("↑", "Previous source match", () =>
    findPrevious(view),
  );
  const next = button("↓", "Next source match", () => findNext(view));
  const matchCase = button("Aa", "Match case", () => {
    caseSensitive = !caseSensitive;
    commit();
  });
  const whole = button("Word", "Whole words", () => {
    wholeWord = !wholeWord;
    commit();
  });
  const regex = button(".*", "Regular expression", () => {
    regexp = !regexp;
    commit();
  });
  const replacement = document.createElement("div");
  replacement.className = "source-find-row";
  replacement.hidden = true;
  const replace = document.createElement("input");
  replace.type = "text";
  replace.setAttribute("aria-label", "Replace in source");
  replace.placeholder = "Replace with…";
  const replaceOne = button("Replace", "Replace source match", () =>
    replaceNext(view),
  );
  const replaceEvery = button("Replace all", "Replace all source matches", () =>
    replaceAll(view),
  );
  replacement.append(replace, replaceOne, replaceEvery);
  const toggle = button("Replace…", "Show replacement", () => {
    replacement.hidden = !replacement.hidden;
    if (!replacement.hidden) replace.focus();
  });
  main.append(
    search,
    count,
    previous,
    next,
    matchCase,
    whole,
    regex,
    toggle,
    button("×", "Close source find", () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );
  dom.append(main, replacement);
  let caseSensitive = false,
    wholeWord = false,
    regexp = false;
  // The committed query, kept so that update() can tell our own query from one
  // another command set. Its pattern can differ from the text in the input.
  let committed: SearchQuery | null = null;
  const commit = () => {
    committed = sourceSearchQuery({
      search: search.value,
      replace: replace.value,
      caseSensitive,
      wholeWord,
      regexp,
    });
    view.dispatch({ effects: setSearchQuery.of(committed) });
  };
  search.oninput = () => {
    const start = search.selectionStart;
    const end = search.selectionEnd;
    commit();
    if (getSearchQuery(view.state).valid) findNext(view);
    // CodeMirror selects the search input after navigation. During live typing,
    // restore its caret so the next character extends the query instead of replacing it.
    search.setSelectionRange(start, end);
  };
  replace.oninput = commit;
  dom.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPanel(view);
      view.focus();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.target === replace) replaceNext(view);
      else (e.shiftKey ? findPrevious : findNext)(view);
    }
  };
  const update = () => {
    const query = getSearchQuery(view.state);
    if (!committed || !query.eq(committed)) {
      // Another command set the query, for example "search for selection".
      committed = query;
      search.value = query.search;
      replace.value = query.replace;
      caseSensitive = query.caseSensitive;
      wholeWord = query.wholeWord;
      regexp = query.regexp;
    }
    matchCase.setAttribute("aria-pressed", String(caseSensitive));
    whole.setAttribute("aria-pressed", String(wholeWord));
    regex.setAttribute("aria-pressed", String(regexp));
    let total = 0,
      current = 0;
    const cursor = query.valid ? query.getCursor(view.state) : null;
    if (cursor)
      for (let item = cursor.next(); !item.done; item = cursor.next()) {
        const hit = item.value;
        total++;
        if (
          view.state.selection.main.from === hit.from &&
          view.state.selection.main.to === hit.to
        )
          current = total;
        if (total > 10000) break;
      }
    count.textContent = !query.search
      ? ""
      : !query.valid
        ? "Invalid pattern"
        : total
          ? `${current || "–"}/${Math.min(total, 10000)}${total > 10000 ? "+" : ""}`
          : "No matches";
    previous.disabled = next.disabled = !total;
    replaceOne.disabled = replaceEvery.disabled =
      !total || view.state.facet(EditorState.readOnly);
  };
  update();
  return {
    dom,
    top: true,
    mount: () => search.select(),
    update: (_update: ViewUpdate) => update(),
  };
}
