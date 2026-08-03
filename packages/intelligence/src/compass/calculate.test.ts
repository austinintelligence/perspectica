import { describe, expect, it } from "vitest";
import { projectCompassWithContext } from "./calculate";

const index = {
  paragraphs: {
    "p-1": { id: "p-1", text: "A policy framing sentence.", speaker: null },
  },
  sentences: {
    "s-1": { id: "s-1", paragraphId: "p-1", text: "A policy framing sentence.", speaker: null },
  },
} as never;

const plan = {
  articleSignals: {
    compass: [
      {
        paragraphIds: ["p-1"],
        sentenceIds: ["s-1"],
        score: -1,
        direction: "left",
        strength: 1,
        explanation: "Article framing.",
        attributed: false,
      },
    ],
  },
} as never;

function context(score: number) {
  return {
    status: "ready" as const,
    summary: "Verified context.",
    signals: [
      {
        id: "context-1",
        sourceKind: "publication-history" as const,
        subject: "Example publication",
        score,
        direction: score < 0 ? ("left" as const) : ("right" as const),
        strength: 1,
        relevance: 1,
        explanation: "Bounded publication context.",
        sourceTitle: "Publication history",
        publication: "Example",
        url: "https://example.com/context",
        citationKind: "source-excerpt" as const,
        excerpt: "A verified context excerpt.",
      },
    ],
    weighting: {
      articleWeight: 0.5,
      publicationHistory: 1,
      journalistWork: 0,
      comparableCoverage: 0,
      topicContext: 0,
      rationale: "Article and context each contribute at most half.",
    },
  };
}

function nonPlacementContext(score: number) {
  const value = context(score);
  return {
    ...value,
    signals: value.signals.map((signal) => ({
      ...signal,
      sourceKind: "comparable-coverage" as const,
    })),
    weighting: {
      ...value.weighting,
      publicationHistory: 0,
      comparableCoverage: 1,
    },
  };
}

describe("V2 one-dimensional compass", () => {
  it("limits context-assisted influence to fifty percent", () => {
    const result = projectCompassWithContext(index, plan, context(1));
    expect(result.basis).toBe("context-assisted");
    expect(result.influence).toEqual({
      article: 0.5,
      publication: 0.5,
      journalist: 0,
      comparableCoverage: 0,
      topicContext: 0,
    });
    expect(result.score).toBe(0);
  });

  it("uses Unclear only when article and context signals are both absent", () => {
    const result = projectCompassWithContext(index, { articleSignals: { compass: [] } } as never, {
      status: "empty",
      summary: "No context.",
      signals: [],
    });
    expect(result.label).toBe("unclear");
    expect(result.score).toBeNull();
  });

  it("permits a low-confidence context-led numeric placement", () => {
    const result = projectCompassWithContext(
      index,
      { articleSignals: { compass: [] } } as never,
      context(-1),
    );
    expect(result.basis).toBe("context-led");
    expect(result.score).toBe(-1);
    expect(result.confidence).toBe("low");
  });

  it("does not let comparable coverage create or shift a political position", () => {
    const articleResult = projectCompassWithContext(index, plan, nonPlacementContext(3));
    expect(articleResult.score).toBe(-1);
    expect(articleResult.basis).toBe("article-led");
    expect(articleResult.influence.comparableCoverage).toBe(0);

    const contextOnly = projectCompassWithContext(
      index,
      { articleSignals: { compass: [] } } as never,
      nonPlacementContext(3),
    );
    expect(contextOnly.label).toBe("unclear");
    expect(contextOnly.score).toBeNull();
  });
});
