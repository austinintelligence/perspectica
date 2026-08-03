import type { ArticleIndex } from "@perspectica/contracts/article";
import {
  CompassResultSchema,
  type CompassEvidence,
  type CompassResult,
  type PoliticalContextResult,
} from "@perspectica/contracts";
import type { AnalysisPlan } from "@perspectica/contracts/report";

const emptyContext: PoliticalContextResult = {
  status: "empty",
  summary: "No external political context was needed to interpret the article's direct framing.",
  signals: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function label(score: number): CompassResult["label"] {
  if (score < -2.25) return "far-left";
  if (score < -1.25) return "left";
  if (score < -0.4) return "center-left";
  if (score <= 0.4) return "center";
  if (score <= 1.25) return "center-right";
  if (score <= 2.25) return "right";
  return "far-right";
}

const display: Record<CompassResult["label"], string> = {
  "far-left": "Far left",
  left: "Left",
  "center-left": "Center-left",
  center: "Center",
  "center-right": "Center-right",
  right: "Right",
  "far-right": "Far right",
  unclear: "Unclear",
};

export function projectArticleCompass(index: ArticleIndex, plan: AnalysisPlan): CompassResult {
  const evidence: CompassEvidence[] = plan.articleSignals.compass
    .slice(0, 12)
    .map((signal, position) => {
      const paragraph = index.paragraphs[signal.paragraphIds[0]!];
      return {
        id: `article-signal-${position + 1}`,
        paragraphId: signal.paragraphIds[0]!,
        excerpt: paragraph?.text.slice(0, 600) ?? "Article signal",
        speaker: paragraph?.speaker ?? null,
        endorsedByArticle: !signal.attributed,
        score: signal.score,
        direction: signal.direction,
        strength: signal.strength,
        relevance: 0.8,
        explanation: signal.explanation,
      };
    });
  const usable = evidence.filter((item) => item.endorsedByArticle);
  if (usable.length === 0) {
    return CompassResultSchema.parse({
      label: "unclear",
      displayLabel: "Unclear",
      score: null,
      confidence: "low",
      confidenceScore: 0.12,
      explanation:
        "The article does not provide enough article-owned framing evidence for a reliable spectrum placement.",
      evidence,
      basis: "insufficient",
      context: emptyContext,
      influence: {
        article: 0,
        publication: 0,
        journalist: 0,
        comparableCoverage: 0,
        topicContext: 0,
      },
    });
  }
  const total = usable.reduce((sum, item) => sum + item.strength * item.relevance, 0);
  const score =
    Math.round(
      clamp(
        usable.reduce((sum, item) => sum + item.score * item.strength * item.relevance, 0) /
          Math.max(total, 0.001),
        -3,
        3,
      ) * 100,
    ) / 100;
  const placement = label(score);
  const consistency =
    1 -
    Math.min(
      1,
      usable.reduce((sum, item) => sum + Math.abs(item.score - score), 0) /
        Math.max(usable.length * 3, 1),
    );
  const confidenceScore =
    Math.round(
      clamp(0.3 + Math.min(0.35, usable.length * 0.08) + consistency * 0.25, 0, 0.86) * 100,
    ) / 100;
  return CompassResultSchema.parse({
    label: placement,
    displayLabel: display[placement],
    score,
    confidence: confidenceScore >= 0.75 ? "high" : confidenceScore >= 0.45 ? "medium" : "low",
    confidenceScore,
    explanation:
      placement === "center"
        ? "The article's own framing is closest to the political center."
        : `The article's own framing is closest to ${display[placement].toLocaleLowerCase("en-US")} on the political spectrum.`,
    evidence,
    basis: "article-led",
    context: emptyContext,
    influence: {
      article: 1,
      publication: 0,
      journalist: 0,
      comparableCoverage: 0,
      topicContext: 0,
    },
  });
}
