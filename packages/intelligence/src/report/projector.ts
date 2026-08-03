import {
  BiasResultSchema,
  SourceListResultSchema,
  type BiasResult,
  type SourceListResult,
} from "@perspectica/contracts";
import type { ArticleIndex } from "@perspectica/contracts/article";
import { normalizeCanonicalUrl } from "@perspectica/contracts/url";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import { EvidenceLedger } from "../evidence/source-ledger";
import {
  synthesizeEvidenceSections,
  type ProjectedEvidenceSections,
} from "../synthesis/evidence-sections";
import { synthesizePerspective, type PerspectiveResult } from "../synthesis/perspective";

const BIAS_LABELS: Record<string, string> = {
  "word-choice": "Word choice",
  speculation: "Speculative framing",
  "unsubstantiated-claims": "Unsubstantiated claim",
  "cherry-picking": "Cherry-picking",
  "source-selection": "Source selection",
  whataboutism: "Whataboutism",
  "false-balance": "False balance",
  "false-dichotomy": "False dichotomy",
  "flawed-comparison": "Flawed comparison",
  generalization: "Generalization",
  "ad-hominem": "Ad hominem",
  "emotional-sensationalism": "Emotional or sensational framing",
  "straw-man": "Straw man",
};

export interface ProjectedReport {
  compass: PerspectiveResult["compass"];
  bias: BiasResult;
  journalistContext: PerspectiveResult["journalistContext"];
  evidence: ProjectedEvidenceSections;
  sourceList: SourceListResult;
}

export function projectBias(plan: AnalysisPlan): BiasResult {
  const findings = plan.articleSignals.bias
    .filter((signal) => !signal.attributed)
    .slice(0, 3)
    .map((signal) => ({
      id: signal.id,
      technique: signal.technique as keyof typeof BIAS_LABELS,
      displayName: BIAS_LABELS[signal.technique] ?? "Framing signal",
      paragraphId: signal.paragraphId,
      excerpt: signal.excerpt,
      explanation: signal.explanation,
      confidence: signal.confidence,
      relevance: signal.confidence,
      prominence: 0.6,
    }));
  return BiasResultSchema.parse({
    status: findings.length > 0 ? "ready" : "empty",
    summary:
      findings.length > 0
        ? "The article contains the following bounded framing signals."
        : "No meaningful article-owned framing pattern stood out in this article.",
    findings,
  });
}

export function projectSourceList(article: ArticleIndex): SourceListResult {
  const links = article.links
    .filter((link) =>
      ["external", "likely-primary", "same-publication"].includes(link.classification),
    )
    .filter((link) => link.classification !== "same-publication" || Boolean(link.paragraphId))
    .map((link) => ({
      id: link.id,
      label: link.label,
      url: normalizeCanonicalUrl(link.url) ?? link.url,
      paragraphId: link.paragraphId,
    }));
  const seen = new Set<string>();
  return SourceListResultSchema.parse({
    status: "ready",
    sources: links
      .filter((link) => {
        if (seen.has(link.url)) return false;
        seen.add(link.url);
        return true;
      })
      .slice(0, 20)
      .map((link) => ({
        id: link.id,
        label: link.label,
        url: link.url,
        paragraphId: link.paragraphId ?? null,
      })),
  });
}

export function projectReport(
  index: ArticleIndex,
  plan: AnalysisPlan,
  ledger: EvidenceLedger,
): ProjectedReport {
  const perspective = synthesizePerspective(index, plan, ledger);
  return {
    compass: perspective.compass,
    bias: projectBias(plan),
    journalistContext: perspective.journalistContext,
    evidence: synthesizeEvidenceSections(ledger),
    sourceList: projectSourceList(index),
  };
}
