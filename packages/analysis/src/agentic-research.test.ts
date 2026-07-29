import type { AnalyzeRequest } from "@perspectica/contracts";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AgenticAiSdkResearchProvider } from "./agentic-research";
import { createFallbackDossier } from "./index";
import type { ResearchSearchResult } from "./research-ai-sdk";

const request: AnalyzeRequest = {
  article: {
    fingerprint: "agentic-research-test",
    canonicalUrl: "https://example.com/story",
    title: "Council approves housing program",
    author: "A. Reporter",
    publication: "Example News",
    publishedAt: "2026-07-28T12:00:00.000Z",
    language: "en",
    contentType: "news",
    paragraphs: [
      {
        id: "p-1",
        index: 0,
        kind: "paragraph",
        speaker: null,
        text: "The council approved a housing program for 1,000 residents.",
      },
    ],
    links: [],
    extraction: {
      extractorVersion: "test-v1",
      extractedAt: "2026-07-28T12:01:00.000Z",
      wordCount: 10,
    },
  },
  client: { extensionVersion: "test" },
};

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function toolStream(toolName: string, toolCallId: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function textStream(output: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text-1" },
        { type: "text-delta" as const, id: "text-1", delta: JSON.stringify(output) },
        { type: "text-end" as const, id: "text-1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

describe("AgenticAiSdkResearchProvider", () => {
  it("forces three parallel searches and reads source contents before accepting evidence", async () => {
    const citedUrl = "https://city.example/housing-record";
    const model = new MockLanguageModelV4({
      doStream: [
        toolStream("searchWeb", "search-1", {
          queries: [
            "housing program official record",
            "housing program independent reporting",
            "housing program capacity qualification",
          ],
          reason: "Find direct, independent, and qualifying evidence.",
        }),
        toolStream("readSources", "read-1", {
          urls: [citedUrl],
          focus: "program capacity",
        }),
        textStream({
          status: "ready",
          summary: "The city record confirms the planned capacity.",
          sources: [
            {
              id: "support-1",
              claimId: "fallback-claim-1",
              title: "Housing program record",
              publication: "Example City",
              publishedAt: null,
              excerpt: "The program will serve 1,000 residents.",
              relationship: "supports",
              relationshipExplanation: "The public record states the same capacity.",
              url: citedUrl,
              sourceType: "primary-record",
              publicationContext: "Official city record",
            },
          ],
          readerCopy: {
            lead: "The city record matches the article's central capacity claim.",
            findings: [
              {
                id: "reader-1",
                text: "The program is planned to serve 1,000 residents.",
                citationIds: ["support-1"],
                keySourceNote: null,
              },
            ],
          },
        }),
      ],
    });
    let activeSearches = 0;
    let maximumParallelSearches = 0;
    const search = vi.fn(async ({ query }: { query: string }) => {
      activeSearches += 1;
      maximumParallelSearches = Math.max(maximumParallelSearches, activeSearches);
      await Promise.resolve();
      activeSearches -= 1;
      return [
        {
          id: query,
          title: "Housing program record",
          url: citedUrl,
          content: "Search preview about the housing program.",
          publishedAt: null,
          score: 0.9,
        } satisfies ResearchSearchResult,
      ];
    });
    const contents = vi.fn(async () => [
      {
        id: "full-record",
        title: "Housing program record",
        url: citedUrl,
        content: "The program will serve 1,000 residents.",
        publishedAt: null,
        score: 0.9,
      },
    ]);
    const provider = new AgenticAiSdkResearchProvider({
      model,
      searchProvider: { search, contents },
    });

    const result = await provider.analyzeEvidence(
      "supporting",
      request,
      createFallbackDossier(request),
    );

    expect(search).toHaveBeenCalledTimes(3);
    expect(maximumParallelSearches).toBe(3);
    expect(contents).toHaveBeenCalledOnce();
    expect(model.doStreamCalls[0]?.responseFormat).toMatchObject({
      type: "json",
      schema: {
        properties: {
          readerCopy: {
            properties: {
              findings: {
                items: {
                  required: expect.arrayContaining(["id", "text", "citationIds", "keySourceNote"]),
                },
              },
            },
          },
        },
      },
    });
    expect(result).toMatchObject({
      status: "ready",
      sources: [{ id: "support-1", url: citedUrl }],
      readerCopy: {
        findings: [{ citationIds: ["support-1"] }],
      },
    });
  });
});
