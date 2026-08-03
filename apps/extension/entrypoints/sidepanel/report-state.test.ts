import { describe, expect, it } from "vitest";
import { PipelineEventSchema, type PipelineEvent } from "@perspectica/contracts/events";
import { beginExtraction, reducePipelineEvent } from "./report-state";

const emittedAt = "2026-07-28T12:00:00.000Z";

function event(
  input: Omit<PipelineEvent, "analysisId" | "emittedAt"> & { analysisId?: string },
): PipelineEvent {
  return PipelineEventSchema.parse({
    ...input,
    analysisId: input.analysisId ?? "analysis-1",
    emittedAt,
  });
}

function started(analysisId = "analysis-1"): PipelineEvent {
  return event({
    type: "analysis.started",
    analysisId,
    data: {
      analysisId,
      articleFingerprint: "article-1",
      mode: "demo",
      pipelineVersion: "test",
      promptVersion: "test",
      modelVersion: "test",
      reasoningEffort: "medium",
      startedAt: emittedAt,
      contentType: "news",
    },
  });
}

describe("reducePipelineEvent", () => {
  it("tracks indexing, planning, retrieval, perspective, and composition phases", () => {
    let state = reducePipelineEvent(beginExtraction(), started());
    expect(state.phase).toBe("index");

    state = reducePipelineEvent(
      state,
      event({ type: "phase.changed", data: { phase: "planning", message: "Planning research." } }),
    );
    expect(state.phase).toBe("plan");
    expect(state.phaseMessage).toBe("Planning research.");

    state = reducePipelineEvent(
      state,
      event({
        type: "phase.changed",
        data: { phase: "retrieving", message: "Retrieving evidence." },
      }),
    );
    state = reducePipelineEvent(
      state,
      event({
        type: "research.progress",
        data: {
          candidateCount: 0,
          completedMissions: 1,
          totalMissions: 3,
          acceptedSources: 2,
          acceptedAssertions: 3,
          sufficiency: "Continue checking.",
        },
      }),
    );
    expect(state.phase).toBe("retrieval");
    expect(state.research?.completedMissions).toBe(1);

    state = reducePipelineEvent(
      state,
      event({
        type: "phase.changed",
        data: { phase: "adjudicating", message: "Comparing perspectives." },
      }),
    );
    expect(state.phase).toBe("perspective");
    state = reducePipelineEvent(
      state,
      event({
        type: "phase.changed",
        data: { phase: "composing", message: "Writing the report." },
      }),
    );
    expect(state.phase).toBe("composition");
  });

  it("applies new section.ready and terminal events", () => {
    let state = reducePipelineEvent(beginExtraction(), started());
    state = reducePipelineEvent(
      state,
      event({
        type: "section.ready",
        data: {
          section: "bias",
          data: { status: "empty", summary: "No meaningful framing signal.", findings: [] },
        },
      }),
    );
    expect(state.bias.status).toBe("empty");

    state = reducePipelineEvent(
      state,
      event({
        type: "analysis.completed",
        data: {
          completedAt: emittedAt,
          durationMs: 1_000,
          status: "partial",
          failedSections: ["supporting", "works-cited"],
          acceptedSources: 1,
          acceptedAssertions: 1,
        },
      }),
    );
    expect(state.phase).toBe("partial");
    expect(state.supporting.status).toBe("error");
    expect(state.sourceList.status).toBe("error");
  });

  it("ignores events from an older analysis stream", () => {
    let state = reducePipelineEvent(beginExtraction(), started("analysis-new"));
    state = reducePipelineEvent(
      state,
      event({
        analysisId: "analysis-old",
        type: "phase.changed",
        data: { phase: "composing", message: "Stale event" },
      }),
    );
    expect(state.analysis?.analysisId).toBe("analysis-new");
    expect(state.phase).toBe("index");
  });

  it("isolates streamed section failures for targeted retry", () => {
    let state = reducePipelineEvent(beginExtraction(), started());
    state = reducePipelineEvent(
      state,
      event({
        type: "section.failed",
        data: {
          section: "journalist-context",
          message: "The journalist research lane could not be verified.",
          retryable: true,
        },
      }),
    );

    expect(state.journalistContext).toMatchObject({
      status: "error",
      error: "The journalist research lane could not be verified.",
    });
    expect(state.failedSections).toEqual(["journalist-context"]);
    expect(state.supporting.status).toBe("loading");
  });

  it("prunes duplicate evidence lanes using canonical source URLs", () => {
    let state = reducePipelineEvent(beginExtraction(), started());
    state = reducePipelineEvent(
      state,
      event({
        type: "section.ready",
        data: {
          section: "supporting",
          data: {
            status: "ready",
            summary: "Supporting evidence.",
            sources: [
              {
                id: "supporting-source",
                claimId: "claim-1",
                title: "Supporting source",
                publication: "Example",
                publishedAt: emittedAt,
                relationship: "supports",
                relationshipExplanation: "Supports the claim.",
                url: "https://example.com/story?utm_source=feed",
                sourceType: "independent-reporting",
                publicationContext: null,
                excerpt: "A supporting excerpt.",
              },
            ],
            readerCopy: {
              lead: "This is supported.",
              findings: [
                { id: "finding-1", text: "Supported.", citationIds: ["supporting-source"] },
              ],
            },
          },
        },
      }),
    );
    state = reducePipelineEvent(
      state,
      event({
        type: "section.ready",
        data: {
          section: "additional-context",
          data: {
            status: "ready",
            summary: "Additional context.",
            sources: [
              {
                id: "duplicate-source",
                claimId: null,
                title: "Duplicate source",
                publication: "Example",
                publishedAt: emittedAt,
                relationship: "adds-context",
                relationshipExplanation: "Adds context.",
                url: "https://example.com/story#details",
                sourceType: "commentary",
                publicationContext: null,
                excerpt: "Duplicate context.",
              },
            ],
          },
        },
      }),
    );

    expect(state.additionalContext.status).toBe("empty");
    expect(state.additionalContext.data?.sources).toHaveLength(0);
    expect(state.supporting.data?.readerCopy?.findings).toHaveLength(1);
  });

  it("rebuilds reader copy from only the sources that remain after pruning", () => {
    let state = reducePipelineEvent(beginExtraction(), started());
    state = reducePipelineEvent(
      state,
      event({
        type: "section.ready",
        data: {
          section: "supporting",
          data: {
            status: "ready",
            summary: "Both the retained and later-pruned claims are supported.",
            sources: [
              {
                id: "retained-source",
                claimId: "claim-1",
                title: "Retained source",
                publication: "Example",
                publishedAt: emittedAt,
                relationship: "supports",
                relationshipExplanation: "Independent reporting supports the retained claim.",
                url: "https://example.com/retained",
                sourceType: "independent-reporting",
                publicationContext: null,
                excerpt: "Retained excerpt.",
              },
              {
                id: "later-pruned-source",
                claimId: "claim-2",
                title: "Later-pruned source",
                publication: "Example",
                publishedAt: emittedAt,
                relationship: "supports",
                relationshipExplanation: "This stale claim must disappear.",
                url: "https://example.com/shared",
                sourceType: "independent-reporting",
                publicationContext: null,
                excerpt: "Pruned excerpt.",
              },
            ],
            readerCopy: {
              lead: "Both claims appear in this lead.",
              findings: [
                { id: "kept", text: "Retained finding.", citationIds: ["retained-source"] },
                {
                  id: "removed",
                  text: "Removed finding.",
                  citationIds: ["later-pruned-source"],
                },
              ],
            },
          },
        },
      }),
    );
    state = reducePipelineEvent(
      state,
      event({
        type: "section.ready",
        data: {
          section: "contradicting",
          data: {
            status: "ready",
            summary: "Qualification.",
            sources: [
              {
                id: "contradicting-source",
                claimId: "claim-2",
                title: "Contradicting source",
                publication: "Example",
                publishedAt: emittedAt,
                relationship: "contradicts",
                relationshipExplanation: "The source materially qualifies the second claim.",
                url: "https://example.com/shared?utm_source=test",
                sourceType: "independent-reporting",
                publicationContext: null,
                excerpt: "Contradicting excerpt.",
              },
            ],
          },
        },
      }),
    );

    expect(state.supporting.data?.sources.map((source) => source.id)).toEqual(["retained-source"]);
    expect(state.supporting.data?.summary).toBe(
      "Independent reporting supports the retained claim.",
    );
    expect(state.supporting.data?.readerCopy).toEqual({
      lead: "Independent reporting supports the retained claim.",
      findings: [{ id: "kept", text: "Retained finding.", citationIds: ["retained-source"] }],
    });
  });
});
