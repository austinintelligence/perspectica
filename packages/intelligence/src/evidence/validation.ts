import type {
  EvidenceAdjudication,
  EvidenceCandidate,
  EvidenceCard,
  EvidenceValidation,
  SourceRecord,
} from "@perspectica/contracts/evidence";
import type { ArticleIndex } from "@perspectica/contracts/article";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import { normalizeCanonicalUrl, normalizeEvidenceText } from "./normalization";
import { excerptMatchesContent } from "./normalization";

function result(
  accepted: boolean,
  provenance: EvidenceValidation["provenance"],
  excerptMatches: boolean,
  reason: string,
  claimRelevant = false,
  relationshipChecked = false,
): EvidenceValidation {
  return {
    accepted,
    provenance,
    excerptMatches,
    claimRelevant,
    relationshipChecked,
    reason,
  };
}

function words(value: string): string[] {
  return normalizeEvidenceText(value)
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}

function containsSubject(haystack: string, subject: string): boolean {
  const source = normalizeEvidenceText(haystack).toLocaleLowerCase("en-US");
  const expected = words(subject);
  return (
    expected.length > 0 &&
    expected.filter((word) => source.includes(word)).length >= expected.length
  );
}

function claimAnchorMatches(
  candidate: EvidenceCandidate,
  claim: AnalysisPlan["claims"][number],
  article: ArticleIndex,
): boolean {
  const haystack = normalizeEvidenceText(
    `${candidate.content} ${candidate.discoveryContext ?? ""} ${candidate.title}`,
  ).toLocaleLowerCase("en-US");
  const referencedParagraphs = new Set(claim.paragraphIds);
  const anchors = [
    ...article.entities
      .filter((entity) => referencedParagraphs.has(entity.paragraphId))
      .map((entity) => entity.text),
    ...article.quantities
      .filter((quantity) => referencedParagraphs.has(quantity.paragraphId))
      .map((quantity) => quantity.text),
    ...article.dates
      .filter((date) => referencedParagraphs.has(date.paragraphId))
      .map((date) => date.text),
  ];
  if (
    anchors.some((anchor) =>
      haystack.includes(normalizeEvidenceText(anchor).toLocaleLowerCase("en-US")),
    )
  )
    return true;
  const claimWords = words(claim.text);
  const overlap = claimWords.filter((word) => haystack.includes(word)).length;
  return overlap >= Math.min(3, Math.max(1, Math.ceil(claimWords.length * 0.2)));
}

function expectedContextSubject(
  mission: AnalysisPlan["missions"][number],
  article: ArticleIndex,
): string | null {
  if (mission.purpose === "journalist-context") return article.meta.author;
  if (mission.purpose === "publication-context") return article.meta.publication;
  if (mission.purpose === "comparable-coverage") return article.meta.title;
  return null;
}

function expectedContextKind(
  mission: AnalysisPlan["missions"][number],
): "publication-history" | "journalist-work" | "comparable-coverage" | "topic-context" | null {
  switch (mission.purpose) {
    case "journalist-context":
      return "journalist-work";
    case "publication-context":
      return "publication-history";
    case "comparable-coverage":
      return "comparable-coverage";
    case "missing-background":
      return "topic-context";
    default:
      return null;
  }
}

function basicUrlValidation(
  card: Pick<EvidenceCard, "sourceUrl" | "contentKind" | "content" | "excerpt">,
  articleUrl: string,
) {
  const canonicalUrl = normalizeCanonicalUrl(card.sourceUrl);
  if (!canonicalUrl)
    return {
      canonicalUrl: null,
      validation: result(false, "unknown", false, "The provider returned an invalid URL."),
    };
  if (normalizeCanonicalUrl(articleUrl) === canonicalUrl)
    return {
      canonicalUrl,
      validation: result(
        false,
        "article-link",
        false,
        "The current article cannot independently verify itself.",
      ),
    };
  if (card.contentKind === "source-text") {
    if (!card.content.trim())
      return {
        canonicalUrl,
        validation: result(false, "verified-url", false, "Source text was empty."),
      };
    if (!card.excerpt || !excerptMatchesContent(card.excerpt, card.content))
      return {
        canonicalUrl,
        validation: result(
          false,
          "verified-url",
          false,
          "The exact excerpt was not found in the source text.",
        ),
      };
  }
  if (card.contentKind === "search-summary" && card.excerpt)
    return {
      canonicalUrl,
      validation: result(
        false,
        "verified-url",
        false,
        "Search summaries cannot carry quoteable excerpts.",
      ),
    };
  return {
    canonicalUrl,
    validation: result(
      true,
      "verified-url",
      card.contentKind === "source-text",
      "Provider URL and content mechanics validated.",
    ),
  };
}

/**
 * Validate the semantic handoff from the bounded adjudicator into the ledger.
 * The provider's mission purpose is never treated as a relationship decision.
 */
export function validateEvidenceAdjudication(
  decision: EvidenceAdjudication,
  candidate: EvidenceCandidate,
  article: ArticleIndex,
  plan: AnalysisPlan,
): EvidenceValidation & { canonicalUrl: string | null } {
  const basic = basicUrlValidation(
    {
      sourceUrl: candidate.sourceUrl,
      contentKind: candidate.contentKind,
      content: candidate.content,
      excerpt: decision.excerpt,
    },
    article.meta.canonicalUrl,
  );
  if (!basic.validation.accepted || !basic.canonicalUrl)
    return { ...basic.validation, canonicalUrl: basic.canonicalUrl };

  if (decision.candidateId !== candidate.id)
    return {
      ...result(false, "verified-url", false, "The adjudicator referenced an unknown candidate."),
      canonicalUrl: basic.canonicalUrl,
    };
  // A provider mission is discovery provenance only. The bounded adjudicator
  // may map a candidate to any planned mission when the source actually
  // matches that mission's claim boundary.
  const mission = plan.missions.find((value) => value.id === decision.missionId);
  if (!mission)
    return {
      ...result(false, "verified-url", false, "The adjudicator referenced an unknown mission."),
      canonicalUrl: basic.canonicalUrl,
    };

  const claim = decision.claimId
    ? plan.claims.find((value) => value.id === decision.claimId)
    : undefined;
  if (decision.claimId && !claim)
    return {
      ...result(false, "verified-url", false, "The adjudicator referenced an unknown claim."),
      canonicalUrl: basic.canonicalUrl,
    };
  if (claim && !mission.claimIds.includes(claim.id))
    return {
      ...result(false, "verified-url", false, "The claim is outside the mission boundary."),
      canonicalUrl: basic.canonicalUrl,
    };
  if (["supports", "contradicts", "qualifies"].includes(decision.relationship) && !claim)
    return {
      ...result(
        false,
        "verified-url",
        false,
        "Claim relationships require an exact planned claim.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (
    candidate.contentKind === "search-summary" &&
    ["supports", "contradicts", "qualifies"].includes(decision.relationship)
  )
    return {
      ...result(
        false,
        "verified-url",
        false,
        "A search summary cannot independently establish support or contradiction.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (claim && !claimAnchorMatches(candidate, claim, article))
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "The source does not contain a validated claim anchor.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };

  const expectedKind = expectedContextKind(mission);
  const subject = expectedContextSubject(mission, article);
  if (expectedKind && ["journalist-work", "publication-history"].includes(expectedKind) && !subject)
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "Context identity is unavailable in the article metadata.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (decision.context && !expectedKind)
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "Political context signals are restricted to context missions.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (expectedKind && !decision.context)
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "Context missions require a source-backed context signal.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (decision.context && decision.context.sourceKind !== expectedKind && expectedKind)
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "The context signal does not match the mission purpose.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (decision.context) {
    const expectedDirection =
      decision.context.score < -0.2 ? "left" : decision.context.score > 0.2 ? "right" : "center";
    if (decision.context.direction !== expectedDirection)
      return {
        ...result(
          false,
          "verified-url",
          basic.validation.excerptMatches,
          "The context direction does not match its bounded score.",
        ),
        canonicalUrl: basic.canonicalUrl,
      };
  }
  if (
    subject &&
    decision.context &&
    !containsSubject(`${decision.context.subject} ${decision.statement}`, subject)
  )
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "The source-backed context did not identify the requested subject.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (
    expectedKind &&
    subject &&
    !containsSubject(
      `${candidate.title} ${candidate.content} ${candidate.discoveryContext ?? ""} ${decision.statement}`,
      subject,
    )
  )
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "The candidate does not identify the requested context subject.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };
  if (
    /\b(?:surfaced|relevant source|not fetched as a transcript|returned this url)\b/i.test(
      decision.statement,
    )
  )
    return {
      ...result(
        false,
        "verified-url",
        basic.validation.excerptMatches,
        "The adjudicator returned discovery prose instead of source-backed evidence.",
      ),
      canonicalUrl: basic.canonicalUrl,
    };

  return {
    ...result(
      true,
      "verified-url",
      basic.validation.excerptMatches,
      "Candidate URL, claim anchor, exact excerpt, and adjudicated relationship validated.",
      Boolean(claim) || Boolean(expectedKind),
      true,
    ),
    canonicalUrl: basic.canonicalUrl,
  };
}

/** Compatibility boundary for callers that still validate a fully formed card. */
export function validateEvidenceCard(
  card: EvidenceCard,
  articleUrl: string,
): EvidenceValidation & { canonicalUrl: string | null } {
  const checked = basicUrlValidation(card, articleUrl);
  return { ...checked.validation, canonicalUrl: checked.canonicalUrl };
}

export function mergeSource(existing: SourceRecord | undefined, next: SourceRecord): SourceRecord {
  if (!existing) return next;
  if (existing.contentKind === "search-summary" && next.contentKind === "source-text") return next;
  if (next.content.length > existing.content.length && next.contentKind === existing.contentKind)
    return next;
  return existing;
}
