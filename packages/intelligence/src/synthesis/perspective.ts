import {
  JournalistContextResultSchema,
  type JournalistContextResult,
  type PoliticalContextResult,
} from "@perspectica/contracts";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import type { ArticleIndex } from "@perspectica/contracts/article";
import { EvidenceLedger } from "../evidence/source-ledger";
import { projectArticleCompass } from "../compass/calculate";

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
  return {
    compass: projectArticleCompass(index, plan),
    politicalContext: {
      status: "empty",
      summary: "Article-owned evidence remains the primary spectrum basis in this bounded pass.",
      signals: [],
    },
    journalistContext,
  };
}
