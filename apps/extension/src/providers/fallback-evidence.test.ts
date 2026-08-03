import { describe, expect, it, vi } from "vitest";
import type {
  EvidenceBatch,
  EvidenceRetriever,
  RetrievalPlan,
} from "@perspectica/contracts/evidence";
import { FallbackEvidenceRetriever } from "./fallback-evidence";

const plan: RetrievalPlan = {
  missions: [
    {
      id: "mission-1",
      claimIds: [],
      purpose: "missing-background",
      queryVariants: ["example"],
      priority: 1,
      estimatedCost: 1,
      freshness: "timeless",
      preferredSourceTypes: ["independent-reporting"],
      includeDomains: [],
      excludeDomains: [],
      canServeSections: ["additional-context"],
    },
  ],
  maxSources: 2,
  maxConcurrency: 1,
  deadlineAt: Date.now() + 30_000,
};

function batch(
  provider: EvidenceBatch["provider"],
  candidates: EvidenceBatch["candidates"],
): EvidenceBatch {
  return {
    missionId: "mission-1",
    provider,
    candidates,
    coveredMissionIds: ["mission-1"],
    status: "completed",
    error: null,
    searched: true,
    cacheHit: false,
    durationMs: 1,
  };
}

async function* batches(values: EvidenceBatch[]): AsyncIterable<EvidenceBatch> {
  yield* values;
}

describe("provider fallback ladder", () => {
  it("uses free retrieval after an empty selected-provider mission and reports it", async () => {
    const fallback = vi.fn(() => batches([batch("free", [])]));
    const diagnostics: unknown[] = [];
    const retriever = new FallbackEvidenceRetriever(
      "exa",
      { retrieve: () => batches([batch("exa", [])]) },
      { retrieve: fallback },
      (event) => diagnostics.push(event),
    );
    const result = [];
    for await (const value of retriever.retrieve(plan, new AbortController().signal))
      result.push(value);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.map((value) => value.provider)).toEqual(["exa", "free"]);
    expect(diagnostics[0]).toMatchObject({
      primaryProvider: "exa",
      fallbackProvider: "free",
      reason: "empty",
      missionIds: ["mission-1"],
    });
  });

  it("converts a free-provider failure into an empty batch so article-only analysis can continue", async () => {
    const retriever = new FallbackEvidenceRetriever(
      "chatgpt",
      { retrieve: () => batches([batch("chatgpt", [])]) },
      {
        retrieve: async function* () {
          throw new Error("network down");
        },
      },
    );
    const result = [];
    for await (const value of retriever.retrieve(plan, new AbortController().signal))
      result.push(value);

    expect(result.at(-1)).toMatchObject({
      provider: "free",
      status: "failed",
      candidates: [],
      coveredMissionIds: ["mission-1"],
    });
  });
});
