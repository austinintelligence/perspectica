import type {
  EvidenceCard,
  EvidenceValidation,
  SourceRecord,
} from "@perspectica/contracts/evidence";
import { normalizeCanonicalUrl } from "./normalization";
import { excerptMatchesContent } from "./normalization";

export function validateEvidenceCard(
  card: EvidenceCard,
  articleUrl: string,
): EvidenceValidation & { canonicalUrl: string | null } {
  const canonicalUrl = normalizeCanonicalUrl(card.sourceUrl);
  if (!canonicalUrl)
    return {
      accepted: false,
      provenance: "unknown",
      excerptMatches: false,
      reason: "The provider returned an invalid URL.",
      canonicalUrl: null,
    };
  const articleCanonical = normalizeCanonicalUrl(articleUrl);
  if (articleCanonical === canonicalUrl)
    return {
      accepted: false,
      provenance: "article-link",
      excerptMatches: false,
      reason: "The current article cannot independently verify itself.",
      canonicalUrl,
    };
  if (card.contentKind === "source-text") {
    if (!card.content.trim())
      return {
        accepted: false,
        provenance: "verified-url",
        excerptMatches: false,
        reason: "Source text was empty.",
        canonicalUrl,
      };
    if (card.excerpt && !excerptMatchesContent(card.excerpt, card.content))
      return {
        accepted: false,
        provenance: "verified-url",
        excerptMatches: false,
        reason: "The exact excerpt was not found in the source text.",
        canonicalUrl,
      };
  }
  if (card.contentKind === "search-summary" && card.excerpt)
    return {
      accepted: false,
      provenance: "verified-url",
      excerptMatches: false,
      reason: "Search summaries cannot carry quoteable excerpts.",
      canonicalUrl,
    };
  return {
    accepted: true,
    provenance: "verified-url",
    excerptMatches: card.contentKind === "search-summary" ? false : Boolean(card.excerpt),
    reason: "Provider URL and content provenance validated.",
    canonicalUrl,
  };
}

export function mergeSource(existing: SourceRecord | undefined, next: SourceRecord): SourceRecord {
  if (!existing) return next;
  if (existing.contentKind === "search-summary" && next.contentKind === "source-text") return next;
  if (next.content.length > existing.content.length && next.contentKind === existing.contentKind)
    return next;
  return existing;
}
