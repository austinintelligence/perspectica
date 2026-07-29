import type {
  CompassBasis,
  CompassEvidence,
  CompassLabel,
  CompassResult,
  Confidence,
  PoliticalContextResult,
  PoliticalContextSignal,
  PoliticalContextSourceKind,
} from "@perspectica/contracts";
import { publicationCalibrationPrior } from "./calibration";

export interface CompassScoringOptions {
  /** Article scores inside this distance from zero are reported as Center. */
  centerThreshold?: number;
  context?: PoliticalContextResult;
  publication?: string | null;
}

interface WeightedScore {
  score: number;
  totalWeight: number;
  count: number;
  consistency: number;
}

const CONTEXT_KINDS = [
  "publication-history",
  "journalist-work",
  "comparable-coverage",
  "topic-context",
] as const satisfies readonly PoliticalContextSourceKind[];

type ContextScores = Record<PoliticalContextSourceKind, WeightedScore>;

const EMPTY_WEIGHTED_SCORE: WeightedScore = {
  score: 0,
  totalWeight: 0,
  count: 0,
  consistency: 0,
};

const EMPTY_CONTEXT: PoliticalContextResult = {
  status: "empty",
  summary: "No verified publication or journalist context was available for the spectrum.",
  signals: [],
};

const displayLabels: Record<CompassLabel, string> = {
  "far-left": "Far left",
  left: "Left",
  "center-left": "Center-left",
  center: "Center",
  "center-right": "Center-right",
  right: "Right",
  "far-right": "Far right",
  unclear: "Unclear",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundScore(value: number): number {
  return Math.round(clamp(value, -3, 3) * 100) / 100;
}

function scoreItems(
  items: Array<{ score: number; strength: number; relevance: number }>,
): WeightedScore {
  const weighted = items
    .map((item) => ({
      score: clamp(item.score, -3, 3),
      weight: item.strength * item.relevance,
    }))
    .filter((item) => item.weight > 0);
  const totalWeight = weighted.reduce((total, item) => total + item.weight, 0);
  if (totalWeight === 0) {
    return { score: 0, totalWeight: 0, count: 0, consistency: 0 };
  }

  const score = weighted.reduce((total, item) => total + item.score * item.weight, 0) / totalWeight;
  const averageDistance =
    weighted.reduce((total, item) => total + Math.abs(item.score - score) * item.weight, 0) /
    totalWeight;

  return {
    score: roundScore(score),
    totalWeight,
    count: weighted.length,
    consistency: clamp(1 - averageDistance / 3, 0, 1),
  };
}

function scoreArticle(evidence: CompassEvidence[]): WeightedScore {
  return scoreItems(evidence.filter((item) => item.endorsedByArticle));
}

function scoreContext(signals: PoliticalContextSignal[]): WeightedScore {
  return scoreItems(
    signals.map((signal) => ({
      ...signal,
      // A journalist's prior work is useful context, but it should never
      // outweigh the current article or durable publication research.
      strength: signal.strength * (signal.sourceKind === "journalist-work" ? 0.7 : 1),
    })),
  );
}

function scoreContextByKind(signals: PoliticalContextSignal[]): ContextScores {
  return Object.fromEntries(
    CONTEXT_KINDS.map((kind) => [
      kind,
      scoreContext(signals.filter((signal) => signal.sourceKind === kind)),
    ]),
  ) as ContextScores;
}

function labelScore(score: number, centerThreshold: number): CompassLabel {
  if (score < -2.25) return "far-left";
  if (score < -1.25) return "left";
  if (score < -centerThreshold) return "center-left";
  if (score < centerThreshold) return "center";
  if (score <= 1.25) return "center-right";
  if (score <= 2.25) return "right";
  return "far-right";
}

function confidenceLabel(score: number): Confidence {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function influenceFor(
  hasArticle: boolean,
  context: PoliticalContextResult,
  scores: ContextScores,
): CompassResult["influence"] {
  const requested = context.weighting;
  const raw = {
    "publication-history": requested?.publicationHistory ?? 0.65,
    "journalist-work": requested?.journalistWork ?? 0.1,
    "comparable-coverage": requested?.comparableCoverage ?? 0.2,
    "topic-context": requested?.topicContext ?? 0.05,
  } satisfies Record<PoliticalContextSourceKind, number>;
  const available = CONTEXT_KINDS.filter((kind) => scores[kind].count > 0);
  const contextTotal = available.reduce((total, kind) => total + raw[kind], 0);
  if (contextTotal === 0) {
    return {
      article: hasArticle ? 1 : 0,
      publication: 0,
      journalist: 0,
      comparableCoverage: 0,
      topicContext: 0,
    };
  }
  const article = hasArticle ? (requested?.articleWeight ?? 0.5) : 0;
  const contextShare = hasArticle ? 1 - article : 1;
  const shareFor = (kind: PoliticalContextSourceKind) =>
    contextTotal > 0 && scores[kind].count > 0 ? (contextShare * raw[kind]) / contextTotal : 0;

  return {
    article,
    publication: shareFor("publication-history"),
    journalist: shareFor("journalist-work"),
    comparableCoverage: shareFor("comparable-coverage"),
    topicContext: shareFor("topic-context"),
  };
}

function determineBasis(hasArticle: boolean, hasContext: boolean): CompassBasis {
  if (hasArticle && hasContext) return "context-assisted";
  if (hasArticle) return "article-led";
  if (hasContext) return "context-led";
  return "insufficient";
}

function combineScores(
  article: WeightedScore,
  context: ContextScores,
  influence: CompassResult["influence"],
): number {
  return roundScore(
    article.score * influence.article +
      context["publication-history"].score * influence.publication +
      context["journalist-work"].score * influence.journalist +
      context["comparable-coverage"].score * influence.comparableCoverage +
      context["topic-context"].score * influence.topicContext,
  );
}

function confidenceScore(
  article: WeightedScore,
  context: ContextScores,
  influence: CompassResult["influence"],
  basis: CompassBasis,
  score: number,
): number {
  const contextItems = CONTEXT_KINDS.map((kind) => context[kind]);
  const available = [article, ...contextItems].filter((item) => item.count > 0);
  const averageStrength =
    available.length === 0
      ? 0
      : available.reduce(
          (total, item) => total + Math.min(item.totalWeight / Math.max(item.count, 1), 1),
          0,
        ) / available.length;
  const consistency =
    available.length === 0
      ? 0
      : available.reduce((total, item) => total + item.consistency, 0) / available.length;
  const articleCoverage = Math.min(article.count / 4, 1);
  const contextCoverage = Math.min(contextItems.filter((item) => item.count > 0).length / 3, 1);
  const compared = [
    ...(article.count > 0 ? [{ score: article.score, weight: influence.article }] : []),
    ...CONTEXT_KINDS.filter((kind) => context[kind].count > 0).map((kind) => ({
      score: context[kind].score,
      weight:
        kind === "publication-history"
          ? influence.publication
          : kind === "journalist-work"
            ? influence.journalist
            : kind === "comparable-coverage"
              ? influence.comparableCoverage
              : influence.topicContext,
    })),
  ];
  const comparisonWeight = compared.reduce((total, item) => total + item.weight, 0);
  const crossConsistency =
    comparisonWeight === 0
      ? 0
      : clamp(
          1 -
            compared.reduce(
              (total, item) => total + Math.abs(item.score - score) * item.weight,
              0,
            ) /
              comparisonWeight /
              3,
          0,
          1,
        );

  const raw =
    basis === "context-led"
      ? contextCoverage * 0.3 + averageStrength * 0.25 + consistency * 0.25 + crossConsistency * 0.2
      : articleCoverage * 0.35 +
        averageStrength * 0.18 +
        consistency * 0.22 +
        contextCoverage * 0.1 +
        crossConsistency * 0.15;
  const cap = basis === "context-led" ? 0.44 : basis === "context-assisted" ? 0.9 : 0.86;
  return Math.round(Math.min(cap, clamp(raw, 0, 1)) * 100) / 100;
}

function explainPlacement(label: CompassLabel, basis: CompassBasis): string {
  if (basis === "calibrated-fallback") {
    return label === "center"
      ? "The calibrated baseline is closest to the political center."
      : `The calibrated baseline is closest to ${displayLabels[label].toLocaleLowerCase("en-US")} on the political spectrum.`;
  }
  if (label === "center") {
    return basis === "context-led"
      ? "The available publication and journalist research is closest to the political center."
      : "The article's framing is closest to the political center after the available context is considered.";
  }
  const subject =
    basis === "context-led"
      ? "The available publication and journalist research"
      : basis === "context-assisted"
        ? "The article's framing, refined by publication and journalist research,"
        : "The article's framing";
  return `${subject} is closest to ${displayLabels[label].toLocaleLowerCase("en-US")} on the political spectrum.`;
}

export function calculateSpectrum(
  candidates: CompassEvidence[],
  options: CompassScoringOptions = {},
): CompassResult {
  const centerThreshold = options.centerThreshold ?? 0.4;
  const context = options.context ?? EMPTY_CONTEXT;
  const accepted = candidates.filter((item) => item.endorsedByArticle);
  const article = scoreArticle(accepted);
  const contextScores = scoreContextByKind(context.signals);
  const hasArticle = article.count > 0;
  const hasContext = CONTEXT_KINDS.some((kind) => contextScores[kind].count > 0);
  const basis = determineBasis(hasArticle, hasContext);
  const influence = influenceFor(hasArticle, context, contextScores);

  // Research exhaustion does not force the reader into an unhelpful “Unclear”
  // state. Use the calibrated publication sample when available, otherwise
  // choose the least-assumptive Center position. Confidence and basis make the
  // weakness of this fallback explicit.
  if (basis === "insufficient") {
    const calibration = publicationCalibrationPrior(options.publication);
    const score = calibration?.score ?? 0;
    const label = labelScore(score, centerThreshold);
    return {
      label,
      displayLabel: displayLabels[label],
      score,
      confidence: "low",
      confidenceScore: calibration ? 0.22 : 0.1,
      explanation: calibration
        ? `Article-specific signals were sparse after research, so this low-confidence placement starts from Perspectica's ${calibration.sampleSize}-article ${calibration.publication} calibration sample.`
        : "Article-specific signals were sparse after research, so Center is the least-assumptive low-confidence placement.",
      evidence: accepted.slice(0, 12),
      basis: "calibrated-fallback",
      context,
      influence: calibration
        ? {
            article: 0,
            publication: 1,
            journalist: 0,
            comparableCoverage: 0,
            topicContext: 0,
          }
        : {
            article: 0,
            publication: 0,
            journalist: 0,
            comparableCoverage: 0,
            topicContext: 0,
          },
    };
  }

  const score = combineScores(article, contextScores, influence);
  const label = labelScore(score, centerThreshold);
  const numericConfidence = confidenceScore(article, contextScores, influence, basis, score);

  return {
    label,
    displayLabel: displayLabels[label],
    score,
    confidence: confidenceLabel(numericConfidence),
    confidenceScore: numericConfidence,
    explanation: explainPlacement(label, basis),
    evidence: accepted.slice(0, 12),
    basis,
    context,
    influence,
  };
}

// Transitional alias: existing event and package names can migrate without
// changing the wire protocol in the middle of the POC.
export const calculateCompass = calculateSpectrum;
export { publicationCalibrationPrior };
