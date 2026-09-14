/** Transparent screening aid, not a probability of relevance or correctness. */
const stop = new Set(
  "a an and are as at be been being but by can could did do does for from had has have how i if in into is it its may of on or our should that the their them there these they this those to using was we were what when where which who why will with would you your ein eine einer eines einen einem und oder der die das den dem des ist sind im in am an auf aus bei fur von zu zum zur wie welche welcher welches wird werden mit sich nicht als es sie wir".split(
    " ",
  ),
);
const terms = (text: string) => [
  ...new Set(
    (
      text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? []
    ).filter((t) => !stop.has(t)),
  ),
];
export interface TopicRelevance {
  score: number | null;
  matchedTerms: string[];
  basis: "title" | "title_abstract";
}
export function topicRelevance<
  T extends { id: string; title: string; abstract?: string },
>(nodes: T[], question: string): Map<string, TopicRelevance> {
  const query = terms(question).slice(0, 100);
  if (!query.length)
    return new Map(
      nodes.map((node) => [
        node.id,
        {
          score: null,
          matchedTerms: [],
          basis: node.abstract ? "title_abstract" : "title",
        },
      ]),
    );
  const documents = nodes.map(
    (node) => new Set(terms(`${node.title} ${node.abstract ?? ""}`)),
  );
  const weights = new Map(
    query.map((term) => [
      term,
      Math.log(
        1 +
          nodes.length / (1 + documents.filter((doc) => doc.has(term)).length),
      ),
    ]),
  );
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return new Map(
    nodes.map((node, i) => {
      const matched = query.filter((term) => documents[i].has(term));
      return [
        node.id,
        {
          score: total
            ? Math.round(
                (100 *
                  matched.reduce((sum, term) => sum + weights.get(term)!, 0)) /
                  total,
              )
            : null,
          matchedTerms: matched,
          basis: node.abstract ? "title_abstract" : "title",
        },
      ];
    }),
  );
}
