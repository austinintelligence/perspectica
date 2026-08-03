import type { RetrievalPlan } from "@perspectica/contracts/evidence";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateText }));

import { NativeChatGptEvidenceRetriever } from "./chatgpt-evidence";
import { ExaEvidenceRetriever } from "./exa-evidence";

const plan: RetrievalPlan = {
  missions: [
    {
      id: "mission-1",
      claimIds: ["claim-1"],
      purpose: "independent-verification",
      queryVariants: ["city council housing vote"],
      priority: 1,
      estimatedCost: 1,
      freshness: "recent",
      preferredSourceTypes: ["independent-reporting"],
      includeDomains: [],
      excludeDomains: [],
      canServeSections: ["supporting"],
    },
  ],
  maxSources: 4,
  maxConcurrency: 1,
  deadlineAt: Date.now() + 10_000,
};

describe("V2 evidence providers", () => {
  beforeEach(() => generateText.mockReset());

  it("keeps Exa returned text and validates exact excerpts downstream", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Council record",
                url: "https://city.gov/record?utm_source=test#top",
                text: "The council approved the housing plan.",
                highlights: ["The council approved the housing plan."],
                publishedDate: "2026-08-01T00:00:00Z",
                score: 0.91,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const retriever = new ExaEvidenceRetriever("exa-test-key", fetchImplementation);
    const batches = [];
    for await (const batch of retriever.retrieve(plan, new AbortController().signal))
      batches.push(batch);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(batches[0]?.candidates[0]).toMatchObject({
      sourceUrl: "https://city.gov/record",
      contentKind: "source-text",
      discoveryExcerpt: "The council approved the housing plan.",
    });
    expect(batches[0]?.candidates[0]).not.toHaveProperty("relationship");
    expect(batches[0]?.candidates[0]).not.toHaveProperty("statement");
  });

  it("makes one native global search call and emits non-quoteable summaries", async () => {
    generateText.mockResolvedValue({
      text: "A concise search result note.",
      sources: [{ sourceType: "url", title: "Council record", url: "https://city.gov/record" }],
    });
    const provider = ((modelId: string) => ({ modelId })) as never;
    (provider as { openai: unknown }).openai = {
      tools: { webSearch: vi.fn(() => ({ type: "web_search" })) },
    };
    const retriever = new NativeChatGptEvidenceRetriever(provider, "gpt-5.6-luna");
    const batches = [];
    for await (const batch of retriever.retrieve(plan, new AbortController().signal))
      batches.push(batch);

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(batches[0]?.candidates[0]).toMatchObject({
      contentKind: "search-summary",
      sourceUrl: "https://city.gov/record",
      missionId: null,
    });
    expect(batches[0]?.candidates[0]).not.toHaveProperty("relationship");
    expect(batches[0]?.candidates[0]).not.toHaveProperty("excerpt");
  });
});
