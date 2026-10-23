// Small pure helpers shared by more than one route module.

/** Accept a pasted cookie in any common shape: bare value, name=value, full header, "Cookie:" prefix. */
export function normalizeCookie(input: string): string {
  let c = input.trim().replace(/^cookie:\s*/i, "").replace(/;\s*$/, "");
  if (!c.includes("=")) c = `overleaf_session2=${c}`;
  return c;
}

/** Paths of the files appearing in a unified working diff. */
export function diffPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) {
      paths.add(m[1]);
      paths.add(m[2]);
    }
  }
  return paths;
}
