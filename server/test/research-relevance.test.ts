import { describe, it, expect } from "vitest";
import { topicRelevance } from "../src/research/relevance.js";
import { graphNeighborhood, searchGraph } from "../../web/src/components/graph-model.js";
const nodes = [
  { id: "W1", title: "Graph representation learning", abstract: "Relational prediction using message passing" },
  { id: "W2", title: "Clinical trial design" },
  { id: "W3", title: "Graph algorithms" },
];
describe("transparent paper screening signals", () => {
  it("distinguishes topic match from impact and leaves missing questions unscored", () => {
    const scores = topicRelevance(nodes, "How does relational graph representation learning work?");
    expect(scores.get("W1")!.score).toBeGreaterThan(scores.get("W3")!.score!);
    expect(scores.get("W2")!.score).toBe(0);
    expect(scores.get("W1")!.matchedTerms).toContain("relational");
    expect(scores.get("W1")!.basis).toBe("title_abstract");
    expect(scores.get("W3")!.basis).toBe("title");
    expect(topicRelevance(nodes, "").get("W1")!.score).toBeNull();
    expect(topicRelevance(nodes, "the and").get("W1")!.score).toBeNull();
  });
  it("searches authors, DOI and keys without case/diacritic sensitivity", () => {
    const paper = { ...nodes[0], authors: ["Émilie Müller"], doi: "10.1234/graph", keys: ["smith2026"], inProject: true, resolved: true, referencesLoaded: true };
    expect(searchGraph([paper], "emilie muller")).toEqual([paper]);
    expect(searchGraph([paper], "SMITH2026 10.1234")).toEqual([paper]);
    expect(searchGraph([paper], "unrelated")).toEqual([]);
  });
  it("keeps neighborhood depth and arrow direction distinct on cycles", () => {
    const edges = [{ from: "W1", to: "W2" }, { from: "W2", to: "W3" }, { from: "W3", to: "W1" }].map(edge => ({ ...edge, source: "OpenAlex", at: "now" }));
    expect([...graphNeighborhood(edges, "W1", 1, "outgoing")]).toEqual(["W1", "W2"]);
    expect([...graphNeighborhood(edges, "W1", 1, "incoming")]).toEqual(["W1", "W3"]);
    expect(graphNeighborhood(edges, "W1", 2, "both").size).toBe(3);
  });
});
