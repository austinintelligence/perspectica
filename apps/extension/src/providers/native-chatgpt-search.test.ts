import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateText }));

import { NativeChatGptSearchProvider } from "./native-chatgpt-search";

function request(query: string) {
  return {
    query,
    topic: "news" as const,
    maxResults: 3,
    excludeDomains: [],
  };
}

function provider() {
  const provider = ((modelId: string) => ({ modelId })) as never;
  (provider as { openai?: unknown }).openai = {
    tools: { webSearch: vi.fn(() => ({ type: "web_search" })) },
  };
  return provider;
}

describe("NativeChatGptSearchProvider", () => {
  beforeEach(() => {
    generateText.mockReset();
  });

  it("does not attribute aggregate model text to individual URLs", async () => {
    generateText.mockResolvedValue({
      text: "Aggregate notes mentioning several sources.",
      sources: [
        { sourceType: "url", id: "source-a", title: "A", url: "https://example.com/a" },
        { sourceType: "url", id: "source-b", title: "B", url: "https://example.com/b" },
      ],
    });
    const results = await new NativeChatGptSearchProvider(provider(), "gpt-5.4").search(
      request("compare the reporting"),
    );

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.content)).toEqual(["", ""]);
    expect(results.map((result) => result.contentKind)).toEqual(["search-note", "search-note"]);
    expect(results.map((result) => result.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("returns source text only when a dedicated read cites the exact target page", async () => {
    generateText.mockResolvedValue({
      text: "“The exact sourced passage.”\nNearby context from the same page.",
      sources: [
        {
          sourceType: "url",
          id: "source-a",
          title: "Exact article",
          url: "https://example.com/article?utm_source=test#section",
        },
      ],
    });

    const results = await new NativeChatGptSearchProvider(provider(), "gpt-5.4").contents({
      urls: ["https://EXAMPLE.com/article/"],
      query: "the central claim",
    });

    expect(results).toEqual([
      {
        id: "source-a",
        title: "Exact article",
        url: "https://example.com/article",
        content: "“The exact sourced passage.”\nNearby context from the same page.",
        publishedAt: null,
        score: null,
        contentKind: "search-note",
      },
    ]);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Open this exact source URL: https://example.com/article"),
        timeout: { totalMs: 60_000, firstChunkMs: 45_000, chunkMs: 30_000 },
      }),
    );
  });

  it("discards an aggregate read when it cites any page besides the target", async () => {
    generateText.mockResolvedValue({
      text: "Notes that combine two different pages.",
      sources: [
        {
          sourceType: "url",
          id: "target",
          title: "Target",
          url: "https://example.com/article",
        },
        {
          sourceType: "url",
          id: "other",
          title: "Other",
          url: "https://example.com/other",
        },
      ],
    });

    const results = await new NativeChatGptSearchProvider(provider(), "gpt-5.4").contents({
      urls: ["https://example.com/article"],
    });

    expect(results).toEqual([]);
  });

  it("reads multiple URLs in isolated calls and keeps only independently attributed results", async () => {
    generateText
      .mockResolvedValueOnce({
        text: "Evidence from A.",
        sources: [
          {
            sourceType: "url",
            id: "a",
            title: "A",
            url: "https://one.example/a",
          },
        ],
      })
      .mockResolvedValueOnce({
        text: "Mixed evidence.",
        sources: [
          {
            sourceType: "url",
            id: "b",
            title: "B",
            url: "https://two.example/b",
          },
          {
            sourceType: "url",
            id: "c",
            title: "C",
            url: "https://two.example/c",
          },
        ],
      });

    const results = await new NativeChatGptSearchProvider(provider(), "gpt-5.4").contents({
      urls: ["https://one.example/a", "https://two.example/b"],
      query: "compare the facts",
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      {
        id: "a",
        title: "A",
        url: "https://one.example/a",
        content: "Evidence from A.",
        publishedAt: null,
        score: null,
        contentKind: "search-note",
      },
    ]);
  });

  it("deduplicates and bounds discovery URLs while enforcing excluded domains", async () => {
    generateText.mockResolvedValue({
      text: "Aggregate discovery notes.",
      sources: [
        {
          sourceType: "url",
          id: "tracking",
          title: "Tracked",
          url: "https://example.com/a?utm_campaign=test",
        },
        {
          sourceType: "url",
          id: "duplicate",
          title: "Duplicate",
          url: "https://example.com/a#top",
        },
        {
          sourceType: "url",
          id: "excluded",
          title: "Excluded",
          url: "https://news.blocked.test/story",
        },
        {
          sourceType: "url",
          id: "second",
          title: "Second",
          url: "https://other.example/b",
        },
      ],
    });

    const results = await new NativeChatGptSearchProvider(provider(), "gpt-5.4").search({
      ...request("find reporting"),
      maxResults: 2,
      excludeDomains: ["blocked.test"],
    });

    expect(
      results.map(({ id, url, content, contentKind }) => ({ id, url, content, contentKind })),
    ).toEqual([
      { id: "tracking", url: "https://example.com/a", content: "", contentKind: "search-note" },
      { id: "second", url: "https://other.example/b", content: "", contentKind: "search-note" },
    ]);
  });

  it("reports and rethrows a failed one-source read", async () => {
    const diagnostics = vi.fn();
    generateText.mockRejectedValue(new Error("native search unavailable"));
    const native = new NativeChatGptSearchProvider(provider(), "gpt-5.4", diagnostics, 12_345);

    await expect(native.contents({ urls: ["https://example.com/article"] })).rejects.toThrow(
      "native search unavailable",
    );
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "contents",
        outcome: "failed",
        resultCount: 0,
        error: "native search unavailable",
      }),
    );
  });
});
