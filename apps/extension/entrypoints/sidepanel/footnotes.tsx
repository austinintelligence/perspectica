import type { ReactNode } from "react";
import { normalizeCanonicalUrl, type ReaderCopy } from "@perspectica/contracts";

export interface CitationTarget {
  id: string;
  title: string;
  publication: string;
  url: string;
  publishedAt?: string | null;
  citationKind?: "source-excerpt" | "search-summary";
}

export interface FootnoteEntry {
  number: number;
  key: string;
  citation: CitationTarget;
}

export function canonicalCitationKey(value: string): string {
  return normalizeCanonicalUrl(value) ?? value.trim();
}

export function buildFootnoteLedger(
  citationIds: readonly string[],
  citations: ReadonlyMap<string, CitationTarget>,
): { entries: FootnoteEntry[]; numbers: ReadonlyMap<string, number> } {
  const entries: FootnoteEntry[] = [];
  const numbers = new Map<string, number>();
  const keys = new Map<string, number>();
  for (const id of citationIds) {
    const citation = citations.get(id);
    if (!citation) continue;
    const key = canonicalCitationKey(citation.url);
    const existing = keys.get(key);
    const number = existing ?? entries.length + 1;
    if (existing === undefined) {
      keys.set(key, number);
      entries.push({ number, key, citation });
    }
    numbers.set(id, number);
  }
  return { entries, numbers };
}

export function acceptedReaderCopy(
  copy: ReaderCopy,
  citations: ReadonlyMap<string, CitationTarget>,
): ReaderCopy | null {
  const findings = copy.findings.filter(
    (finding) =>
      finding.citationIds.length > 0 && finding.citationIds.every((id) => citations.has(id)),
  );
  if (findings.length === 0) return null;
  return {
    ...copy,
    lead:
      findings.length === copy.findings.length
        ? copy.lead
        : "The verified findings are summarized below.",
    findings,
  };
}

function scopeId(scope: string): string {
  return scope.replace(/[^a-z0-9_-]+/gi, "-");
}

export function FootnoteMarker({
  scope,
  number,
  citation,
}: {
  scope: string;
  number: number;
  citation: CitationTarget;
}) {
  return (
    <sup className="footnote-marker">
      <a
        href={`#${scopeId(scope)}-footnote-${number}`}
        aria-label={`Footnote ${number}: ${citation.title}`}
      >
        {number}
      </a>
    </sup>
  );
}

export function SectionFootnotes({
  scope,
  entries,
}: {
  scope: string;
  entries: readonly FootnoteEntry[];
}) {
  if (entries.length === 0) return null;
  const safeScope = scopeId(scope);
  return (
    <aside className="section-footnotes" aria-label="Sources for this section">
      <h3>Notes</h3>
      <ol>
        {entries.map(({ number, citation }) => (
          <li id={`${safeScope}-footnote-${number}`} key={`${safeScope}-${number}`}>
            <a href={citation.url} target="_blank" rel="noreferrer">
              {citation.title}
            </a>
            {citation.publication ? <small>{` · ${citation.publication}`}</small> : null}
            {citation.publishedAt ? (
              <small>{` · ${new Date(citation.publishedAt).toLocaleDateString()}`}</small>
            ) : null}
            {citation.citationKind === "search-summary" ? (
              <small className="search-summary-label"> · Web-search summary</small>
            ) : null}
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function InlineFootnotes({
  citationIds,
  citations,
  scope,
  numbers,
}: {
  citationIds: readonly string[];
  citations: ReadonlyMap<string, CitationTarget>;
  scope: string;
  numbers: ReadonlyMap<string, number>;
}) {
  const seen = new Set<number>();
  const markers: ReactNode[] = [];
  for (const id of citationIds) {
    const citation = citations.get(id);
    const number = numbers.get(id);
    if (!citation || !number || seen.has(number)) continue;
    seen.add(number);
    markers.push(
      <FootnoteMarker
        key={`${scope}-${number}`}
        scope={scope}
        number={number}
        citation={citation}
      />,
    );
  }
  return markers.length > 0 ? (
    <span className="inline-citations" aria-label="Sources">
      {markers}
    </span>
  ) : null;
}
