import type { ReferenceMetadata } from "../api";

export default function ReferenceDetails({ metadata }: { metadata?: ReferenceMetadata }) {
  if (!metadata) return null;
  const { venue, venueType, venueSource, citationCount, citationSource, citationUrl, citationUpdatedAt, conferenceRanking } = metadata;
  if (!venue && citationCount === undefined) return null;
  const countTitle = `Citations indexed for this record by ${citationSource ?? "the source"}${citationUpdatedAt ? ` · checked ${new Date(citationUpdatedAt).toLocaleDateString()}` : ""}. Coverage may be incomplete, and other versions may have separate records.${citationCount === 0 ? " No indexed citations does not mean the paper has never been cited." : " Counts vary by index."}`;
  const countLabel = citationCount === 0 ? "No citations indexed" : `${citationCount?.toLocaleString()} ${citationCount === 1 ? "citation" : "citations"}`;
  const countText = <><span className="font-mono text-[11px] font-medium text-leaf">{countLabel}</span>{citationSource && <span className="text-[10px] text-graphite"> · {citationSource}</span>}</>;
  const countClass = "inline-flex flex-wrap items-baseline gap-x-1 rounded-md border border-leaf/25 bg-leaf/5 px-2 py-1 transition-colors hover:border-leaf/50";
  return (
    <div className="mt-2 space-y-2 text-[11px] text-graphite">
      {venue && <p title={`Venue from ${venueSource ?? "the source"}`} className="break-words text-[11px] leading-relaxed text-paper-dim">
        {venueType === "conference" ? "Conference" : venueType === "journal" ? "Journal" : "Venue"}: {venue}
      </p>}
      <div className="flex flex-wrap items-center gap-1.5">
      {conferenceRanking && <a
        href={/^https:\/\/portal\.core\.edu\.au\/conf-ranks\/\d+\/$/.test(conferenceRanking.url) ? conferenceRanking.url : "https://portal.core.edu.au/conf-ranks/"}
        target="_blank" rel="noreferrer"
        title={`${conferenceRanking.title} · ${conferenceRanking.edition} conference ranking, not the paper's publication-year ranking. Checked ${new Date(conferenceRanking.checkedAt).toLocaleDateString()}.`}
        className="rounded-md border border-gold/30 bg-gold/5 px-2 py-1 font-mono text-[10px] text-gold transition-colors hover:border-gold"
      >{conferenceRanking.edition.replace(/(\d{4})$/, " $1")} · {conferenceRanking.rank} ↗</a>}
      {citationCount !== undefined && (citationUrl && /^https?:\/\//i.test(citationUrl)
        ? <a href={citationUrl} target="_blank" rel="noreferrer" title={countTitle} className={countClass}>{countText}<span aria-hidden="true" className="text-leaf/70"> ↗</span></a>
        : <span title={countTitle} className={countClass}>{countText}</span>)}
      </div>
    </div>
  );
}
