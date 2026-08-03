import { describe, expect, it } from "vitest";
import type { AnalysisJob } from "./messages";
import {
  canReuseAnalysisJob,
  createAnalysisConfigFingerprint,
  tabUrlChanged,
} from "./report-reuse";

const article = {
  canonicalUrl: "https://example.com/story?utm_source=newsletter#comments",
  fingerprint: "fingerprint-a",
};
const preferences = {
  model: "gpt-5.6-luna" as const,
  reasoningEffort: "medium" as const,
  mode: "balanced" as const,
  depth: "balanced" as const,
  searchProvider: "exa" as const,
};
const configFingerprint = createAnalysisConfigFingerprint(preferences);

function job(overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: "job-1",
    tabId: 7,
    tabUrl: "https://example.com/story",
    articleFingerprint: "fingerprint-a",
    analysisConfigFingerprint: configFingerprint,
    status: "complete",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:01.000Z",
    error: null,
    events: [],
    runToken: "run-1",
    revision: 1,
    lastEventSequence: 1,
    ...overrides,
  };
}

describe("canReuseAnalysisJob", () => {
  it("includes V2 pipeline versions and depth in the reuse fingerprint", () => {
    expect(configFingerprint).toContain("analysis-config-v2");
    expect(configFingerprint).toContain("intelligence-graph-v2");
    expect(configFingerprint).toContain(":balanced:balanced:exa");
  });

  it("reuses a report when tab, canonical URL, and fingerprint match", () => {
    expect(canReuseAnalysisJob(job(), article, 7, configFingerprint)).toBe(true);
  });

  it("does not reuse a same-URL report for a changed article fingerprint", () => {
    expect(
      canReuseAnalysisJob(
        job(),
        { ...article, fingerprint: "fingerprint-b" },
        7,
        configFingerprint,
      ),
    ).toBe(false);
  });

  it("does not reuse a report when an explicit retry requests a fresh run", () => {
    expect(canReuseAnalysisJob(job(), article, 7, configFingerprint, true)).toBe(false);
  });

  it("does not reuse reports from another tab or terminal failure states", () => {
    expect(canReuseAnalysisJob(job(), article, 8, configFingerprint)).toBe(false);
    expect(canReuseAnalysisJob(job({ status: "failed" }), article, 7, configFingerprint)).toBe(
      false,
    );
    expect(canReuseAnalysisJob(job({ status: "cancelled" }), article, 7, configFingerprint)).toBe(
      false,
    );
  });

  it("invalidates a report when any output-affecting preference changes", () => {
    const changed = [
      createAnalysisConfigFingerprint({ ...preferences, model: "gpt-5.6-sol" }),
      createAnalysisConfigFingerprint({ ...preferences, reasoningEffort: "high" }),
      createAnalysisConfigFingerprint({ ...preferences, mode: "deep" }),
      createAnalysisConfigFingerprint({ ...preferences, depth: "verified" }),
      createAnalysisConfigFingerprint({ ...preferences, searchProvider: "chatgpt" }),
    ];

    for (const fingerprint of changed) {
      expect(canReuseAnalysisJob(job(), article, 7, fingerprint)).toBe(false);
    }
    expect(
      canReuseAnalysisJob(job({ analysisConfigFingerprint: null }), article, 7, configFingerprint),
    ).toBe(false);
  });
});

describe("tabUrlChanged", () => {
  it("allows a cross-origin canonical alias when the actual tab did not navigate", () => {
    expect(tabUrlChanged("https://m.example.com/story", "https://m.example.com/story")).toBe(false);
  });

  it("detects same-origin navigation to a different article", () => {
    expect(tabUrlChanged("https://example.com/story-a", "https://example.com/story-b")).toBe(true);
  });
});
