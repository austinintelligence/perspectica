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
          failedSections: ["supporting"],
          acceptedSources: 1,
          acceptedAssertions: 1,
        },
      }),
    );
    expect(state.phase).toBe("partial");
    expect(state.supporting.status).toBe("error");
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
});
