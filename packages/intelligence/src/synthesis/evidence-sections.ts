import {
  AdditionalContextResultSchema,
  EvidenceSectionSchema,
  ExternalSourceSchema,
  type AdditionalContextResult,
  type EvidenceSection,
  type ExternalSource,
} from "@perspectica/contracts";
import type { ReportSection } from "@perspectica/contracts/report";
import { EvidenceLedger } from "../evidence/source-ledger";
import { readerCopyFromAssertions } from "./reader-copy";

function sourcesFor(
  ledger: EvidenceLedger,
  relationship: "supports" | "contradicts" | "qualifies" | "adds-context",
  blocked: ReadonlySet<string>,
  limit: number,
): {
  sources: ExternalSource[];
  assertions: Array<{ id: string; statement: string; sourceId: string }>;
} {
  const sourceById = new Map(ledger.getSources().map((source) => [source.id, source]));
  const assertions: Array<{ id: string; statement: string; sourceId: string }> = [];
  const sources: ExternalSource[] = [];
  const used = new Set<string>();
  for (const assertion of ledger.getAssertions()) {
    if (
      assertion.relationship !== relationship &&
      !(relationship === "contradicts" && assertion.relationship === "qualifies")
    )
      continue;
    if (used.has(assertion.sourceId) || blocked.has(assertion.sourceId)) continue;
    const source = sourceById.get(assertion.sourceId);
    if (!source) continue;
    used.add(source.id);
    const external =
      source.contentKind === "source-text"
        ? {
            id: source.id,
            claimId: assertion.claimId,
            title: source.title,
            publication: source.publication,
            publishedAt: source.publishedAt,
            relationship: assertion.relationship,
            relationshipExplanation: assertion.statement,
            url: source.canonicalUrl,
            sourceType: source.sourceType,
            publicationContext: null,
            citationKind: "source-excerpt" as const,
            excerpt: assertion.excerpt ?? source.content.slice(0, 400),
          }
        : {
            id: source.id,
            claimId: assertion.claimId,
            title: source.title,
            publication: source.publication,
            publishedAt: source.publishedAt,
            relationship: assertion.relationship,
            relationshipExplanation: assertion.statement,
            url: source.canonicalUrl,
            sourceType: source.sourceType,
            publicationContext: null,
            citationKind: "search-summary" as const,
            excerpt: null,
          };
    sources.push(ExternalSourceSchema.parse(external));
    assertions.push({ id: assertion.id, statement: assertion.statement, sourceId: source.id });
    if (sources.length >= limit) break;
  }
  return { sources, assertions };
}

export interface ProjectedEvidenceSections {
  supporting: EvidenceSection;
  contradicting: EvidenceSection;
  additionalContext: AdditionalContextResult;
}

export function synthesizeEvidenceSections(ledger: EvidenceLedger): ProjectedEvidenceSections {
  const contradictingData = sourcesFor(ledger, "contradicts", new Set(), 3);
  const contradictingIds = new Set(contradictingData.sources.map((source) => source.id));
  const supportingData = sourcesFor(ledger, "supports", contradictingIds, 3);
  const blocked = new Set([
    ...contradictingIds,
    ...supportingData.sources.map((source) => source.id),
  ]);
  const contextData = sourcesFor(ledger, "adds-context", blocked, 2);
  const supporting = EvidenceSectionSchema.parse({
    status: supportingData.sources.length > 0 ? "ready" : "empty",
    summary:
      supportingData.sources.length > 0
        ? "Independent sources support parts of the article's central claims."
        : "No independently sourced supporting information was verified.",
    sources: supportingData.sources,
    emptyReason: supportingData.sources.length > 0 ? undefined : "no-verified-evidence",
    readerCopy: readerCopyFromAssertions(
      supportingData.assertions,
      "The strongest supporting evidence currently available is shown below.",
    ),
  });
  const contradicting = EvidenceSectionSchema.parse({
    status: contradictingData.sources.length > 0 ? "ready" : "empty",
    summary:
      contradictingData.sources.length > 0
        ? "These sources contradict or materially qualify a central claim."
        : "No responsible contradiction or material qualification was verified.",
    sources: contradictingData.sources,
    emptyReason: contradictingData.sources.length > 0 ? undefined : "no-verified-evidence",
    readerCopy: readerCopyFromAssertions(
      contradictingData.assertions,
      "The report found the following material qualification or contradiction.",
    ),
  });
  const additionalContext = AdditionalContextResultSchema.parse({
    status: contextData.sources.length > 0 ? "ready" : "empty",
    summary:
      contextData.sources.length > 0
        ? "This context helps interpret the central claims without duplicating the other evidence lanes."
        : "No additional outside context was necessary to interpret the central claims.",
    sources: contextData.sources,
    emptyReason: contextData.sources.length > 0 ? undefined : "not-applicable",
    readerCopy: readerCopyFromAssertions(
      contextData.assertions,
      "Additional context is included only where it prevents a likely misunderstanding.",
    ),
  });
  return { supporting, contradicting, additionalContext };
}
