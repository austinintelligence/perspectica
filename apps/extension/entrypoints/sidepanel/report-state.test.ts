import { describe, expect, it } from "vitest";
import { AnalysisEventSchema } from "@perspectica/contracts";
import { beginExtraction, reduceAnalysisEvent } from "./report-state";

const emittedAt = "2026-07-28T12:00:00.000Z";

describe("reduceAnalysisEvent", () => {
  it("moves sections from loading to ready as events stream in", () => {
    let state = beginExtraction();
    state = reduceAnalysisEvent(
      state,
      AnalysisEventSchema.parse({
        type: "analysis.started",
        analysisId: "analysis-1",
        emittedAt,
        data: {
          analysisId: "analysis-1",
          articleFingerprint: "article-1",
          mode: "demo",
          pipelineVersion: "test",
          promptVersion: "test",
          modelVersion: "test",
          reasoningEffort: "medium",
          startedAt: emittedAt,
          contentType: "news",
        },
      }),
    );

    expect(state.phase).toBe("analyzing");
    expect(state.bias.status).toBe("loading");

    state = reduceAnalysisEvent(
      state,
      AnalysisEventSchema.parse({
        type: "bias.ready",
        analysisId: "analysis-1",
        emittedAt,
        data: {
          status: "empty",
          summary: "No meaningful bias techniques were found.",
          findings: [],
        },
      }),
    );

    expect(state.bias.status).toBe("empty");
    expect(state.bias.data?.findings).toEqual([]);
  });

  it("keeps one failed section separate from the rest of the report", () => {
    const state = reduceAnalysisEvent(
      beginExtraction(),
      AnalysisEventSchema.parse({
        type: "section.failed",
        analysisId: "analysis-1",
        emittedAt,
        data: {
          section: "journalist-context",
          message: "Research was unavailable.",
          retryable: true,
        },
      }),
    );

    expect(state.journalistContext.status).toBe("error");
    expect(state.supporting.status).toBe("waiting");
  });

  it("ignores terminal events from an older analysis stream", () => {
    let state = reduceAnalysisEvent(
      beginExtraction(),
      AnalysisEventSchema.parse({
        type: "analysis.started",
        analysisId: "analysis-new",
        emittedAt,
        data: {
          analysisId: "analysis-new",
          articleFingerprint: "article-new",
          mode: "demo",
          pipelineVersion: "test",
          promptVersion: "test",
          modelVersion: "test",
          reasoningEffort: "none",
          startedAt: emittedAt,
          contentType: "news",
        },
      }),
    );

    state = reduceAnalysisEvent(
      state,
      AnalysisEventSchema.parse({
        type: "bias.ready",
        analysisId: "analysis-old",
        emittedAt,
        data: {
          status: "ready",
          summary: "Stale result",
          findings: [],
        },
      }),
    );

    expect(state.bias.status).toBe("loading");
    expect(state.analysis?.analysisId).toBe("analysis-new");
  });

  it("does not let an older started event replace the active analysis", () => {
    let state = reduceAnalysisEvent(
      beginExtraction(),
      AnalysisEventSchema.parse({
        type: "analysis.started",
        analysisId: "analysis-new",
        emittedAt,
        data: {
          analysisId: "analysis-new",
          articleFingerprint: "article-new",
          mode: "demo",
          pipelineVersion: "test",
          promptVersion: "test",
          modelVersion: "test",
          reasoningEffort: "none",
          startedAt: emittedAt,
          contentType: "news",
        },
      }),
    );

    state = reduceAnalysisEvent(
      state,
      AnalysisEventSchema.parse({
        type: "analysis.started",
        analysisId: "analysis-old",
        emittedAt,
        data: {
          analysisId: "analysis-old",
          articleFingerprint: "article-old",
          mode: "demo",
          pipelineVersion: "test",
          promptVersion: "test",
          modelVersion: "test",
          reasoningEffort: "none",
          startedAt: emittedAt,
          contentType: "news",
        },
      }),
    );

    expect(state.analysis?.analysisId).toBe("analysis-new");
  });

  it("preserves a usable partial report when one or more sections fail", () => {
    let state = reduceAnalysisEvent(
      beginExtraction(),
      AnalysisEventSchema.parse({
        type: "analysis.started",
        analysisId: "analysis-partial",
        emittedAt,
        data: {
          analysisId: "analysis-partial",
          articleFingerprint: "article-partial",
          mode: "demo",
          pipelineVersion: "test",
          promptVersion: "test",
          modelVersion: "test",
          reasoningEffort: "medium",
          startedAt: emittedAt,
          contentType: "news",
        },
      }),
    );

    state = reduceAnalysisEvent(
      state,
      AnalysisEventSchema.parse({
        type: "analysis.completed",
        analysisId: "analysis-partial",
        emittedAt,
        data: {
          completedAt: emittedAt,
          durationMs: 1_000,
          status: "partial",
          failedSections: ["bias"],
        },
      }),
    );

    expect(state.phase).toBe("partial");
    expect(state.error).toBeNull();
  });

  it("keeps a repeated source only in the higher-priority contradicting lane", () => {
    const sharedSource = {
      id: "pbs",
      claimId: "claim-1",
      title: "Biden interview tapes",
      publication: "PBS News",
      publishedAt: null,
      excerpt: "Hur described how a jury might evaluate the evidence.",
      relationship: "supports" as const,
      relationshipExplanation: "The report confirms the recordings were released.",
      url: "https://www.pbs.org/newshour/politics/biden-tapes?utm_source=test",
      sourceType: "independent-reporting" as const,
      publicationContext: null,
    };
    let state = beginExtraction();
    state = reduceAnalysisEvent(
      state,
      AnalysisEventSchema.parse({
        type: "supporting.ready",
        analysisId: "analysis-1",
        emittedAt,
        data: {
          status: "ready",
          summary: "PBS confirms the release.",
          sources: [sharedSource],
        },
      }),
    );
    state = reduceAnalysisEvent(
      state,
      AnalysisEventSchema.parse({
        type: "contradicting.ready",
        analysisId: "analysis-1",
        emittedAt,
        data: {
          status: "ready",
          summary: "PBS materially qualifies the stated rationale.",
          sources: [
            {
              ...sharedSource,
              relationship: "qualifies",
              relationshipExplanation: "The report adds a material jury-perception qualification.",
              url: "https://www.pbs.org/newshour/politics/biden-tapes",
            },
          ],
        },
      }),
    );

    expect(state.supporting).toMatchObject({
      status: "empty",
      data: { sources: [] },
    });
    expect(state.contradicting.data?.sources).toHaveLength(1);
  });
});
