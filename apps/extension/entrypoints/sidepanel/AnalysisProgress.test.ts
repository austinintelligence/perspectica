import { describe, expect, it } from "vitest";
import { getAnalysisProgress } from "./AnalysisProgress";
import { beginExtraction, createInitialReportState } from "./report-state";

describe("analysis progress copy", () => {
  it("uses compact, evidence-led updates as the report advances", () => {
    expect(getAnalysisProgress(beginExtraction())).toMatchObject({ label: "Reading the article" });

    const researching = {
      ...createInitialReportState(),
      phase: "analyzing" as const,
      metadata: {
        title: "Article",
        author: null,
        publication: null,
        publishedAt: null,
        contentType: "news" as const,
      },
      compass: { status: "loading" as const, data: null, error: null },
      bias: { status: "loading" as const, data: null, error: null },
      journalistContext: { status: "loading" as const, data: null, error: null },
      supporting: { status: "loading" as const, data: null, error: null },
      contradicting: { status: "loading" as const, data: null, error: null },
      additionalContext: { status: "loading" as const, data: null, error: null },
    };

    expect(getAnalysisProgress(researching)).toMatchObject({ label: "Comparing related coverage" });
    expect(
      getAnalysisProgress({
        ...researching,
        compass: { status: "ready" as const, data: null, error: null },
        bias: { status: "empty" as const, data: null, error: null },
        journalistContext: { status: "ready" as const, data: null, error: null },
        supporting: { status: "ready" as const, data: null, error: null },
      }),
    ).toMatchObject({ label: "Preparing the report" });
  });

  it("does not render after the report reaches a terminal state", () => {
    expect(getAnalysisProgress(createInitialReportState())).toBeNull();
    expect(getAnalysisProgress({ ...createInitialReportState(), phase: "complete" })).toBeNull();
  });
});
