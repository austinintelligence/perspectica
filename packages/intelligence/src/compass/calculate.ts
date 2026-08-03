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

function roundedScore(value: number): number {
  return Math.round(clamp(value, -3, 3) * 100) / 100;
}

function contextScore(context: PoliticalContextResult): {
  score: number;
  weight: number;
} {
  const weighted = context.signals.reduce(
    (total, signal) => total + signal.score * signal.strength * signal.relevance,
    0,
  );
  const weight = context.signals.reduce(
    (total, signal) => total + signal.strength * signal.relevance,
    0,
  );
  return { score: weight > 0 ? roundedScore(weighted / weight) : 0, weight };
}

function contextCounts(context: PoliticalContextResult) {
  return {
    publication: context.signals.filter((signal) => signal.sourceKind === "publication-history")
      .length,
    journalist: context.signals.filter((signal) => signal.sourceKind === "journalist-work").length,
    comparableCoverage: context.signals.filter(
      (signal) => signal.sourceKind === "comparable-coverage",
    ).length,
    topicContext: context.signals.filter((signal) => signal.sourceKind === "topic-context").length,
  };
}

function contextInfluence(
  context: PoliticalContextResult,
  contextWeight: number,
): Pick<
  CompassResult["influence"],
  "publication" | "journalist" | "comparableCoverage" | "topicContext"
> {
  const counts = contextCounts(context);
  const weighting = context.weighting;
  const raw = {
    publication: weighting?.publicationHistory ?? 0.65,
    journalist: weighting?.journalistWork ?? 0.1,
    comparableCoverage: weighting?.comparableCoverage ?? 0.2,
    topicContext: weighting?.topicContext ?? 0.05,
  };
  const available = (Object.keys(counts) as Array<keyof typeof counts>).filter(
    (kind) => counts[kind] > 0,
  );
  const totalWeight = available.reduce((sum, kind) => sum + raw[kind], 0);
  const totalCount = available.reduce((sum, kind) => sum + counts[kind], 0);
  const denominator = totalWeight > 0 ? totalWeight : totalCount;
  return {
    publication:
      contextWeight *
      (denominator > 0
        ? totalWeight > 0
          ? raw.publication / denominator
          : counts.publication / denominator
        : 0),
    journalist:
      contextWeight *
      (denominator > 0
        ? totalWeight > 0
          ? raw.journalist / denominator
          : counts.journalist / denominator
        : 0),
    comparableCoverage:
      contextWeight *
      (denominator > 0
        ? totalWeight > 0
          ? raw.comparableCoverage / denominator
          : counts.comparableCoverage / denominator
        : 0),
    topicContext:
      contextWeight *
      (denominator > 0
        ? totalWeight > 0
          ? raw.topicContext / denominator
          : counts.topicContext / denominator
        : 0),
  };
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
      const sentence = signal.sentenceIds
        .map((sentenceId) => index.sentences[sentenceId])
        .find((value) => value && signal.paragraphIds.includes(value.paragraphId));
      return {
        id: `article-signal-${position + 1}`,
        paragraphId: signal.paragraphIds[0]!,
        excerpt: sentence?.text ?? paragraph?.text.slice(0, 600) ?? "Article signal",
        speaker: sentence?.speaker ?? paragraph?.speaker ?? null,
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

export function projectCompassWithContext(
  index: ArticleIndex,
  plan: AnalysisPlan,
  context: PoliticalContextResult,
): CompassResult {
  const article = projectArticleCompass(index, plan);
  if (context.status !== "ready" || context.signals.length === 0) {
    return CompassResultSchema.parse({ ...article, context });
  }
  const contextual = contextScore(context);
  if (contextual.weight <= 0) return CompassResultSchema.parse({ ...article, context });
  // Direct article signals anchor the placement, while validated context can
  // contribute exactly the remaining half. Context-only placement is allowed
  // when the article contains no endorsed spectrum signal, but remains low
  // confidence and is never presented as article-owned framing.
  const hasArticle = article.score !== null;
  const score = roundedScore(
    hasArticle ? (article.score ?? 0) * 0.5 + contextual.score * 0.5 : contextual.score,
  );
  const placement = label(score);
  const articleWeight = hasArticle ? 0.5 : 0;
  const contextWeight = hasArticle ? 0.5 : 1;
  const confidenceScore = hasArticle
    ? Math.min(0.9, Math.round((article.confidenceScore * 0.7 + 0.16) * 100) / 100)
    : Math.min(
        0.44,
        Math.round((0.22 + Math.min(0.12, context.signals.length * 0.04)) * 100) / 100,
      );
  return CompassResultSchema.parse({
    ...article,
    label: placement,
    displayLabel: display[placement],
    score,
    confidenceScore,
    confidence: confidenceScore >= 0.75 ? "high" : confidenceScore >= 0.45 ? "medium" : "low",
    explanation: hasArticle
      ? `${article.explanation} Bounded publication, journalist, comparable-coverage, and topic-context evidence shifted the contextual estimate cautiously toward ${display[placement].toLocaleLowerCase("en-US")}.`
      : `The available publication, journalist, comparable-coverage, and topic-context research is closest to ${display[placement].toLocaleLowerCase("en-US")} on the political spectrum.`,
    basis: hasArticle ? "context-assisted" : "context-led",
    context,
    influence: {
      article: articleWeight,
      ...contextInfluence(context, contextWeight),
    },
  });
}
