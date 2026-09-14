import type { GraphNode } from "../research";
export default function PaperSignals({
  node,
  question,
  projectCiters,
  projectCount,
}: {
  node: GraphNode;
  question?: string;
  projectCiters: number;
  projectCount: number;
}) {
  const recent =
    node.year !== undefined && new Date().getFullYear() - node.year < 4;
  return (
    <section
      className="cg-signals"
      aria-label="Paper relevance and research signals"
    >
      <h4>Research signals</h4>
      <div className="cg-signal-row">
        <div>
          <strong>
            {node.relevance?.score == null
              ? "—"
              : `${node.relevance.score}/100`}
          </strong>
          <span>Topic match</span>
        </div>
        <p>
          {question ? (
            <>
              Matches your research question using{" "}
              {node.relevance?.basis === "title_abstract"
                ? "title and abstract"
                : "title only"}
              .
            </>
          ) : (
            "Set your research question in Research → Memory to score topic matches."
          )}
        </p>
      </div>
      {!!node.relevance?.matchedTerms.length && (
        <p className="cg-signal-terms">
          Matched: {node.relevance.matchedTerms.join(" · ")}
        </p>
      )}
      <div className="cg-signal-row">
        <div>
          <strong>
            {node.citationPercentile === undefined
              ? "—"
              : `${node.citationPercentile.toFixed(1)}`}
          </strong>
          <span>Citation percentile</span>
        </div>
        <p>
          Compared with papers of the same field, year and type.
          {node.citationPercentile === undefined
            ? " Not available in the loaded metadata."
            : ""}
        </p>
      </div>
      {node.fwci !== undefined && (
        <p className="cg-signal-terms">
          Field-weighted citation impact:{" "}
          <strong>{node.fwci.toFixed(2)}×</strong> expected citations.
        </p>
      )}
      {recent && (
        <p className="cg-signal-terms">
          Early citation history: this paper is less than four years old.
        </p>
      )}
      <p className="cg-signal-terms">
        Cited by {projectCiters} of {projectCount} project papers in this graph.
        Missing edges remain unknown.
      </p>
      <div className={`cg-reliability ${node.retracted ? "flagged" : ""}`}>
        <strong>
          {node.retracted
            ? "Retraction flagged by OpenAlex"
            : "Reliability requires review"}
        </strong>
        <p>
          {node.retracted === false
            ? "No retraction is flagged in the retrieved OpenAlex record. "
            : node.retracted === undefined
              ? "Retraction status is not available. "
              : "Check the publisher’s notice before using this work. "}
          {node.sourceAvailability === "indexed"
            ? "Full text is indexed in your library."
            : node.sourceAvailability === "abstract"
              ? "Your library has only an abstract."
              : node.sourceAvailability === "stale"
                ? "Your indexed source has changed and needs review."
                : "Full-text availability has not been confirmed in your library."}
        </p>
      </div>
      <details>
        <summary>How to interpret these signals</summary>
        <p>
          Topic match is the percentage of research-question terms found in the
          title or abstract, weighted by their rarity in this graph. It is a
          screening aid, not semantic understanding or a probability. Missing
          abstracts reduce the evidence available for matching.
        </p>
        <p>
          Citation impact measures scholarly attention, including critical
          citations. It does not establish that a result is correct. Assess
          methods, data, limitations and independent replications before relying
          on a claim.
        </p>
        <p>
          <a
            href="https://help.openalex.org/data/works/attributes/"
            target="_blank"
            rel="noreferrer"
          >
            OpenAlex metric definitions ↗
          </a>
        </p>
      </details>
    </section>
  );
}
