/** Replace only citation summaries from the current turn; preserve all other notices. */
export function appendChatItem<T extends { kind: string; citationGroup?: string }>(items: T[], item: T): T[] {
  if (item.kind === "notice" && item.citationGroup) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (["user", "turn_end"].includes(items[i].kind)) break;
      if (items[i].kind === "notice" && items[i].citationGroup === item.citationGroup) {
        const next = [...items]; next[i] = item; return next;
      }
    }
  }
  return [...items, item];
}
