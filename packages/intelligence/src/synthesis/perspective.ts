import {
  JournalistContextResultSchema,
  PoliticalContextResultSchema,
  type JournalistContextResult,
  type PoliticalContextResult,
} from "@perspectica/contracts";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import type { ArticleIndex } from "@perspectica/contracts/article";
import { EvidenceLedger } from "../evidence/source-ledger";
import { projectArticleCompass, projectCompassWithContext } from "../compass/calculate";

export interface PerspectiveResult {
  compass: ReturnType<typeof projectArticleCompass>;
  politicalContext: PoliticalContextResult;
  journalistContext: JournalistContextResult;
}

export function synthesizePerspective(
  index: ArticleIndex,
  plan: AnalysisPlan,
  ledger: EvidenceLedger,
): PerspectiveResult {
  const journalistAssertions = ledger
    .getAssertions()
    .filter(
      (assertion) =>
        ledger.plan.missions.find((mission) => mission.id === assertion.missionId)?.purpose ===
        "journalist-context",
    );
  const journalistSources = new Map(ledger.getSources().map((source) => [source.id, source]));
  const journalistContext: JournalistContextResult = JournalistContextResultSchema.parse({
    status: journalistAssertions.length > 0 ? "ready" : "empty",
    summary:
      journalistAssertions.length > 0
        ? "Public work connected to the named journalist was reviewed as bounded context."
        : "No relevant public work by the named journalist was verified for this article.",
    findings: journalistAssertions.slice(0, 3).map((assertion) => {
      const source = journalistSources.get(assertion.sourceId)!;
      return {
        id: assertion.id,
        summary: assertion.statement,
        relevanceExplanation:
          "This source was selected because it is tied to the named journalist mission.",
        sourceTitle: source.title,
        publication: source.publication,
        url: source.canonicalUrl,
        ...(source.contentKind === "source-text"
          ? {
              citationKind: "source-excerpt" as const,
              excerpt: assertion.excerpt ?? source.content.slice(0, 400),
            }
          : { citationKind: "search-summary" as const, excerpt: null }),
      };
    }),
    emptyReason: journalistAssertions.length > 0 ? undefined : "no-verified-evidence",
  });
  const contextAssertions = ledger.getAssertions().filter((assertion) => assertion.context);
  const placementAssertions = contextAssertions.filter(
    (assertion) =>
      assertion.context?.sourceKind === "publication-history" ||
      assertion.context?.sourceKind === "journalist-work",
  );
  const contextSources = new Map(ledger.getSources().map((source) => [source.id, source]));
  const politicalContext: PoliticalContextResult = PoliticalContextResultSchema.parse(
    contextAssertions.length === 0
      ? {
          status: "empty",
          summary:
            "No source-backed publication, journalist, or comparable-coverage signal was verified.",
          signals: [],
        }
      : {
          status: "ready",
          summary:
            "The article-led placement was checked against bounded source-backed context. Context signals describe coverage history, not an author's identity or motive.",
          signals: contextAssertions.slice(0, 8).flatMap((assertion) => {
            const context = assertion.context;
            const source = contextSources.get(assertion.sourceId);
            if (!context || !source) return [];
            return [
              {
                id: assertion.id,
                sourceKind: context.sourceKind,
                subject: context.subject,
                score: context.score,
                direction: context.direction,
                strength: context.strength,
                relevance: context.relevance,
                explanation: context.explanation,
                sourceTitle: source.title,
                publication: source.publication,
                url: source.canonicalUrl,
                ...(source.contentKind === "source-text"
                  ? {
                      citationKind: "source-excerpt" as const,
                      excerpt: assertion.excerpt ?? source.content.slice(0, 400),
                    }
                  : { citationKind: "search-summary" as const, excerpt: null }),
              },
            ];
          }),
          weighting: {
            articleWeight: 0.5,
            publicationHistory:
              placementAssertions.filter(
                (assertion) => assertion.context?.sourceKind === "publication-history",
              ).length / Math.max(placementAssertions.length, 1),
            journalistWork:
              placementAssertions.filter(
                (assertion) => assertion.context?.sourceKind === "journalist-work",
              ).length / Math.max(placementAssertions.length, 1),
            comparableCoverage: 0,
            topicContext: 0,
            rationale:
              "Article-owned signals remain half of the placement. Verified publication history and journalist work share the contextual half; other research may explain but cannot move the score.",
          },
        },
  );
  return {
    compass: projectCompassWithContext(index, plan, politicalContext),
    politicalContext,
    journalistContext,
  };
}
