import type { PipelineEvent } from "@perspectica/contracts/events";
import { describe, expect, it } from "vitest";
import { beginExtraction } from "./report-state";
import { ReportStore } from "./report-store";

const metadata: PipelineEvent = {
  type: "metadata.ready",
  analysisId: "analysis-1",
  emittedAt: "2026-08-02T12:00:00.000Z",
  data: {
    title: "Article",
    author: null,
    publication: "Example",
    publishedAt: null,
    contentType: "news",
  },
};

describe("ReportStore", () => {
  it("notifies only the section whose trusted snapshot changed", () => {
    const store = new ReportStore();
    store.reset(beginExtraction());
    const bias = { count: 0 };
    const supporting = { count: 0 };
    store.subscribeSection("bias", () => {
      bias.count += 1;
    });
    store.subscribeSection("supporting", () => {
      supporting.count += 1;
    });

    store.apply({
      ...metadata,
      type: "section.ready",
      data: { section: "bias", data: { status: "empty", summary: "No signal.", findings: [] } },
    } as PipelineEvent);

    expect(bias.count).toBe(1);
    expect(supporting.count).toBe(0);
    expect(store.getSnapshot().bias.status).toBe("empty");
  });
});
