import { describe, expect, it } from "vitest";
import type {
  CompassEvidence,
  PoliticalContextResult,
  PoliticalContextSignal,
} from "@perspectica/contracts";
import { calculateCompass } from "./index";

function evidence(id: string, score: number, strength = 0.8, relevance = 0.9): CompassEvidence {
  return {
    id,
    paragraphId: `p-${id}`,
    excerpt: `Exact article evidence for ${id}`,
    speaker: null,
    endorsedByArticle: true,
    score,
    direction: score < -0.2 ? "left" : score > 0.2 ? "right" : "center",
    strength,
    relevance,
    explanation: "This article framing supports the score.",
  };
}

function signal(
  id: string,
  sourceKind: PoliticalContextSignal["sourceKind"],
  score: number,
): PoliticalContextSignal {
  return {
    id,
    sourceKind,
    subject: "Publication",
    score,
    direction: score < -0.2 ? "left" : score > 0.2 ? "right" : "center",
    strength: sourceKind === "publication-history" ? 0.4 : 0.25,
    relevance: 0.9,
    explanation: "Independent research describes a durable orientation.",
    sourceTitle: "Independent media profile",
    publication: "Research source",
    url: `https://example.com/${id}`,
    excerpt: "The publication has a documented editorial orientation.",
  };
}

function context(...signals: PoliticalContextSignal[]): PoliticalContextResult {
  return {
    status: signals.length > 0 ? "ready" : "empty",
    summary: signals.length > 0 ? "Verified context." : "No context.",
    signals,
  };
}

describe("calculateCompass seven-position spectrum", () => {
  it.each([
    [-2.8, "far-left"],
    [-1.8, "left"],
    [-0.8, "center-left"],
    [0, "center"],
    [0.8, "center-right"],
    [1.8, "right"],
    [2.8, "far-right"],
  ] as const)("maps %s to %s", (score, label) => {
    const result = calculateCompass([evidence("one", score)]);
    expect(result.label).toBe(label);
    expect(result.score).toBe(score);
  });

  it("treats center as a valid finding rather than uncertainty", () => {
    const result = calculateCompass([evidence("neutral", 0)]);
    expect(result.label).toBe("center");
    expect(result.basis).toBe("article-led");
    expect(result.score).toBe(0);
  });

  it("keeps the exact negative center boundary in Center", () => {
    expect(calculateCompass([evidence("boundary", -0.4)]).label).toBe("center");
    expect(calculateCompass([evidence("outside", -0.41)]).label).toBe("center-left");
  });

  it("uses bounded publication and journalist research to refine article evidence", () => {
    const result = calculateCompass([evidence("article", 0.8)], {
      context: {
        ...context(
          signal("publication", "publication-history", 2),
          signal("journalist", "journalist-work", 1),
        ),
        weighting: {
          articleWeight: 0.4,
          publicationHistory: 0.8,
          journalistWork: 0.2,
          comparableCoverage: 0,
          topicContext: 0,
          rationale: "A durable outlet pattern is more informative than one sparse article.",
        },
      },
    });
    expect(result.basis).toBe("context-assisted");
    expect(result.influence).toEqual({
      article: 0.4,
      publication: 0.48,
      journalist: 0.12,
      comparableCoverage: 0,
      topicContext: 0,
    });
    expect(result.score).toBeGreaterThan(0.8);
  });

  it("lets a durable research pattern outweigh a conflicting sparse article", () => {
    const result = calculateCompass([evidence("article", -0.6, 0.4, 0.5)], {
      context: {
        ...context(signal("publication", "publication-history", 1.5)),
        weighting: {
          articleWeight: 0.4,
          publicationHistory: 1,
          journalistWork: 0,
          comparableCoverage: 0,
          topicContext: 0,
          rationale: "The article has one weak counter-signal against a durable outlet pattern.",
        },
      },
    });

    expect(result.score).toBeGreaterThan(0);
    expect(result.label).toBe("center-right");
    expect(result.confidenceScore).toBeLessThan(0.75);
  });

  it("allows a low-confidence contextual placement when article framing is sparse", () => {
    const result = calculateCompass([], {
      context: context(signal("publication", "publication-history", -1)),
    });
    expect(result.label).toBe("center-left");
    expect(result.basis).toBe("context-led");
    expect(result.confidence).toBe("low");
    expect(result.confidenceScore).toBeLessThanOrEqual(0.44);
  });

  it("uses a low-confidence Center fallback when all research is empty", () => {
    const result = calculateCompass([], { context: context() });
    expect(result.label).toBe("center");
    expect(result.score).toBe(0);
    expect(result.basis).toBe("calibrated-fallback");
    expect(result.confidenceScore).toBe(0.1);
  });

  it("uses the researched calibration sample as a last resort for a known publication", () => {
    const result = calculateCompass([], {
      context: context(),
      publication: "Reuters",
    });
    expect(result.label).toBe("center");
    expect(result.score).toBe(-0.32);
    expect(result.basis).toBe("calibrated-fallback");
    expect(result.confidenceScore).toBe(0.22);
  });

  it("ignores attributed evidence that the article does not endorse", () => {
    const attributed = { ...evidence("quote", -3), endorsedByArticle: false };
    const result = calculateCompass([attributed], {
      context: context(signal("publication", "publication-history", 1)),
    });
    expect(result.label).toBe("center-right");
    expect(result.basis).toBe("context-led");
  });
});
