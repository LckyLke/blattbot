import type { ReferenceMetadata } from "../api";

export default function ReferenceDetails({ metadata }: { metadata?: ReferenceMetadata }) {
  if (!metadata) return null;
  const { venue, venueType, venueSource, citationCount, citationSource, citationUrl, citationUpdatedAt, conferenceRanking } = metadata;
  if (!venue && citationCount === undefined) return null;
  const countTitle = `Citations indexed by ${citationSource ?? "the source"}${citationUpdatedAt ? ` · checked ${new Date(citationUpdatedAt).toLocaleDateString()}` : ""}. Counts vary by index.`;
  const countText = `${citationCount?.toLocaleString()} ${citationCount === 1 ? "citation" : "citations"}${citationSource ? ` · ${citationSource}` : ""}`;
  return (
    <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-graphite">
      {venue && <span title={`Venue from ${venueSource ?? "the source"}`}>
        {venueType === "conference" ? "Conference" : venueType === "journal" ? "Journal" : "Venue"}: {venue}
      </span>}
      {conferenceRanking && <a
        href={/^https:\/\/portal\.core\.edu\.au\/conf-ranks\/\d+\/$/.test(conferenceRanking.url) ? conferenceRanking.url : "https://portal.core.edu.au/conf-ranks/"}
        target="_blank" rel="noreferrer"
        title={`${conferenceRanking.title} · ${conferenceRanking.edition} conference ranking, not the paper's publication-year ranking. Checked ${new Date(conferenceRanking.checkedAt).toLocaleDateString()}.`}
        className="rounded border border-gold/40 px-1.5 py-0.5 font-mono text-[10px] text-gold hover:border-gold"
      >{conferenceRanking.edition.replace(/(\d{4})$/, " $1")} · {conferenceRanking.rank} ↗</a>}
      {citationCount !== undefined && (citationUrl && /^https?:\/\//i.test(citationUrl)
        ? <a href={citationUrl} target="_blank" rel="noreferrer" title={countTitle} className="hover:text-gold">{countText} ↗</a>
        : <span title={countTitle}>{countText}</span>)}
    </div>
  );
}
