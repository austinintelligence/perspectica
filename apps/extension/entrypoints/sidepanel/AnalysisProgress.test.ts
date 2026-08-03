import { describe, expect, it } from "vitest";
import { getAnalysisProgress } from "./AnalysisProgress";
import { beginExtraction, createInitialReportState } from "./report-state";

describe("analysis pipeline progress", () => {
  it("maps five internal stages to four reader-facing phases", () => {
    const state = beginExtraction();
    expect(getAnalysisProgress(state)).toMatchObject({
      phase: "reading",
      label: "Reading article",
      completed: 0,
      total: 4,
    });
    expect(getAnalysisProgress({ ...state, phase: "plan" })).toMatchObject({
      phase: "planning",
      completed: 1,
    });
    expect(
      getAnalysisProgress({
        ...state,
        phase: "retrieval",
        research: {
          candidateCount: 3,
          completedMissions: 2,
          totalMissions: 4,
          acceptedSources: 3,
          acceptedAssertions: 5,
          sufficiency: "more evidence needed",
        },
      }),
    ).toMatchObject({ phase: "researching", detail: "3 sources accepted", completed: 2 });
    expect(getAnalysisProgress({ ...state, phase: "perspective" })).toMatchObject({
      phase: "researching",
      completed: 2,
    });
    expect(getAnalysisProgress({ ...state, phase: "composition" })).toMatchObject({
      phase: "synthesizing",
      completed: 3,
    });
  });

  it("marks timeline steps monotonically", () => {
    const progress = getAnalysisProgress({ ...beginExtraction(), phase: "perspective" });
    expect(progress?.steps.map((step) => step.status)).toEqual([
      "complete",
      "complete",
      "active",
      "waiting",
    ]);
  });

  it("does not render after a terminal state", () => {
    expect(getAnalysisProgress(createInitialReportState())).toBeNull();
    expect(getAnalysisProgress({ ...createInitialReportState(), phase: "complete" })).toBeNull();
  });
});
