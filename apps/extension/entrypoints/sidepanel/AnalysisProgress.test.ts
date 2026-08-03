import { describe, expect, it } from "vitest";
import { getAnalysisProgress } from "./AnalysisProgress";
import { beginExtraction, createInitialReportState } from "./report-state";

describe("analysis pipeline progress", () => {
  it("exposes the five pipeline stages", () => {
    const state = beginExtraction();
    expect(getAnalysisProgress(state)).toMatchObject({ phase: "index", completed: 0, total: 5 });
    expect(
      getAnalysisProgress({ ...state, phase: "plan", phaseMessage: "Planning" }),
    ).toMatchObject({ phase: "plan", label: "Planning research", completed: 1 });
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
    ).toMatchObject({ phase: "retrieval", detail: "2 of 4 missions checked", completed: 2 });
    expect(getAnalysisProgress({ ...state, phase: "perspective" })).toMatchObject({
      phase: "perspective",
      completed: 3,
    });
    expect(getAnalysisProgress({ ...state, phase: "composition" })).toMatchObject({
      phase: "composition",
      completed: 4,
    });
  });

  it("does not render after a terminal state", () => {
    expect(getAnalysisProgress(createInitialReportState())).toBeNull();
    expect(getAnalysisProgress({ ...createInitialReportState(), phase: "complete" })).toBeNull();
  });
});
