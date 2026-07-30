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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("AgenticAiSdkResearchProvider", () => {
  it("runs the two-query evidence budget in parallel and reads source contents", async () => {
    const citedUrl = "https://city.example/housing-record";
    const model = new MockLanguageModelV4({
      doStream: [
        toolStream("searchWeb", "search-1", {
          queries: ["housing program official record", "housing program independent reporting"],
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

    expect(search).toHaveBeenCalledTimes(2);
    expect(maximumParallelSearches).toBe(2);
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

  it("shares duplicate searches and in-flight source reads across specialists", async () => {
    const citedUrl = "https://city.example/shared-record";
    const output = {
      status: "ready",
      summary: "The public record confirms the capacity.",
      sources: [
        {
          id: "shared-support",
          claimId: "fallback-claim-1",
          title: "Shared housing record",
          publication: "Example City",
          publishedAt: null,
          excerpt: "The program will serve 1,000 residents.",
          relationship: "supports",
          relationshipExplanation: "The record states the same capacity.",
          url: citedUrl,
          sourceType: "primary-record",
          publicationContext: "Official record",
        },
      ],
      readerCopy: {
        lead: "The public record matches the capacity claim.",
        findings: [
          {
            id: "shared-reader",
            text: "The program is planned to serve 1,000 residents.",
            citationIds: ["shared-support"],
            keySourceNote: null,
          },
        ],
      },
    };
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const step = modelCall++ % 3;
        if (step === 0) {
          return toolStream("searchWeb", `search-${modelCall}`, {
            queries: ["housing program official record", "housing program independent reporting"],
            reason: "Find direct evidence.",
          });
        }
        if (step === 1) {
          return toolStream("readSources", `read-${modelCall}`, {
            urls: [citedUrl],
            focus: "program capacity",
          });
        }
        return textStream(output);
      },
    });
    const search = vi.fn(async () => [
      {
        id: "search-preview",
        title: "Shared housing record",
        url: citedUrl,
        content: "Search preview",
        publishedAt: null,
        score: 0.9,
      } satisfies ResearchSearchResult,
    ]);
    const contents = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [
        {
          id: "full-shared-record",
          title: "Shared housing record",
          url: citedUrl,
          content: "The program will serve 1,000 residents.",
          publishedAt: null,
          score: 0.9,
        } satisfies ResearchSearchResult,
      ];
    });
    const provider = new AgenticAiSdkResearchProvider({
      model,
      searchProvider: { search, contents },
      maxConcurrentAgents: 2,
      maxConcurrentSearches: 3,
    });
    const dossier = createFallbackDossier(request);

    const results = await Promise.all([
      provider.analyzeEvidence("supporting", request, dossier),
      provider.analyzeEvidence("supporting", request, dossier),
    ]);

    expect(results).toHaveLength(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(contents).toHaveBeenCalledTimes(1);
  });

  it("keeps shared search and source reads alive when the first caller aborts", async () => {
    const citedUrl = "https://city.example/cancellation-safe";
    const searchDeferred = deferred<ResearchSearchResult[]>();
    const contentsDeferred = deferred<ResearchSearchResult[]>();
    const searchResult = {
      id: "shared",
      title: "Shared record",
      url: citedUrl,
      content: "Search preview",
      publishedAt: null,
      score: 0.8,
    } satisfies ResearchSearchResult;
    const search = vi.fn(
      async (_request: { signal?: AbortSignal }) => await searchDeferred.promise,
    );
    const contents = vi.fn(async ({ query }: { query?: string; signal?: AbortSignal }) =>
      query === "capacity"
        ? await contentsDeferred.promise
        : [
            {
              ...searchResult,
              content: `Focused source content for ${query}.`,
            },
          ],
    );
    const provider = new AgenticAiSdkResearchProvider({
      model: new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("not used");
        },
      }),
      searchProvider: { search, contents },
    });
    const internal = provider as unknown as {
      searchShared: (request: {
        query: string;
        topic: "news";
        maxResults: number;
        excludeDomains: string[];
        signal?: AbortSignal;
      }) => Promise<{ results: ResearchSearchResult[]; cacheHit: boolean }>;
      readSharedSource: (
        canonicalUrl: string,
        query: string,
        signal?: AbortSignal,
        contentKind?: "source-text" | "search-note",
      ) => Promise<ResearchSearchResult | undefined>;
    };
    const firstSearchAbort = new AbortController();
    const secondSearchAbort = new AbortController();
    const sharedSearchRequest = {
      query: "shared official record",
      topic: "news" as const,
      maxResults: 3,
      excludeDomains: [],
    };
    const firstSearch = internal.searchShared({
      ...sharedSearchRequest,
      signal: firstSearchAbort.signal,
    });
    const firstSearchRejection = expect(firstSearch).rejects.toMatchObject({
      name: "AbortError",
    });
    const secondSearch = internal.searchShared({
      ...sharedSearchRequest,
      signal: secondSearchAbort.signal,
    });
    firstSearchAbort.abort();
    await firstSearchRejection;
    searchDeferred.resolve([searchResult]);
    await expect(secondSearch).resolves.toMatchObject({ results: [searchResult] });
    await expect(internal.searchShared(sharedSearchRequest)).resolves.toMatchObject({
      results: [searchResult],
      cacheHit: true,
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);

    const firstReadAbort = new AbortController();
    const secondReadAbort = new AbortController();
    const firstRead = internal.readSharedSource(citedUrl, "capacity", firstReadAbort.signal);
    const firstReadRejection = expect(firstRead).rejects.toMatchObject({
      name: "AbortError",
    });
    const secondRead = internal.readSharedSource(citedUrl, "capacity", secondReadAbort.signal);
    firstReadAbort.abort();
    await firstReadRejection;
    const fullResult = { ...searchResult, content: "The complete official record." };
    contentsDeferred.resolve([fullResult]);
    await expect(secondRead).resolves.toEqual(fullResult);
    await expect(internal.readSharedSource(citedUrl, "capacity")).resolves.toEqual(fullResult);
    await expect(internal.readSharedSource(citedUrl, "other focus")).resolves.toMatchObject({
      content: "Focused source content for other focus.",
    });
    await expect(
      internal.readSharedSource(citedUrl, "capacity", undefined, "search-note"),
    ).resolves.toEqual(fullResult);
    expect(contents).toHaveBeenCalledTimes(3);
    expect(contents.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("cancels shared provider work after its final waiter aborts", async () => {
    const providerSignal = deferred<AbortSignal>();
    const search = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<ResearchSearchResult[]>((_, reject) => {
          if (!signal) {
            reject(new Error("expected a provider-owned abort signal"));
            return;
          }
          providerSignal.resolve(signal);
          const rejectForAbort = () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError"),
            );
          if (signal.aborted) rejectForAbort();
          else signal.addEventListener("abort", rejectForAbort, { once: true });
        }),
    );
    const provider = new AgenticAiSdkResearchProvider({
      model: new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("not used");
        },
      }),
      searchProvider: { search },
    });
    const internal = provider as unknown as {
      searchShared: (request: {
        query: string;
        topic: "news";
        maxResults: number;
        excludeDomains: string[];
        signal?: AbortSignal;
      }) => Promise<{ results: ResearchSearchResult[]; cacheHit: boolean }>;
    };
    const caller = new AbortController();
    const result = internal.searchShared({
      query: "orphaned search",
      topic: "news",
      maxResults: 3,
      excludeDomains: [],
      signal: caller.signal,
    });
    const providerOwnedSignal = await providerSignal.promise;

    caller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(providerOwnedSignal.aborted).toBe(true);
    expect(search).toHaveBeenCalledOnce();
  });

  it("accepts political signals only from searches labeled with the same source kind", async () => {
    const publicationUrl = "https://research.example/publication";
    const journalistUrl = "https://research.example/journalist";
    const comparisonUrl = "https://example.com/related-housing-coverage";
    const model = new MockLanguageModelV4({
      doStream: [
        toolStream("searchWeb", "political-search", {
          queries: [
            {
              query: "Example News political orientation",
              sourceKind: "publication-history",
            },
            {
              query: "A. Reporter recurring political framing",
              sourceKind: "journalist-work",
            },
            {
              query: "housing program comparable coverage",
              sourceKind: "comparable-coverage",
            },
          ],
          reason: "Separate outlet, journalist, and comparable-coverage evidence.",
        }),
        toolStream("readSources", "political-read", {
          urls: [publicationUrl, journalistUrl, comparisonUrl],
          focus: "political orientation and recurring framing",
        }),
        textStream({
          status: "ready",
          summary: "The verified context includes distinct outlet and journalist patterns.",
          signals: [
            {
              id: "publication-valid",
              sourceKind: "publication-history",
              subject: "Example News",
              score: 1,
              direction: "right",
              strength: 0.5,
              relevance: 0.9,
              explanation: "Independent research describes the outlet as conservative.",
              sourceTitle: "Publication study",
              publication: "Research Institute",
              url: publicationUrl,
              excerpt: "Example News is a conservative publication.",
            },
            {
              id: "journalist-misattributed",
              sourceKind: "journalist-work",
              subject: "A. Reporter",
              score: 1,
              direction: "right",
              strength: 0.3,
              relevance: 0.8,
              explanation: "This outlet source does not establish journalist provenance.",
              sourceTitle: "Publication study",
              publication: "Research Institute",
              url: publicationUrl,
              excerpt: "Example News is a conservative publication.",
            },
            {
              id: "journalist-valid",
              sourceKind: "journalist-work",
              subject: "A. Reporter",
              score: -1,
              direction: "left",
              strength: 0.3,
              relevance: 0.8,
              explanation: "The journalist source identifies a recurring progressive frame.",
              sourceTitle: "Journalist study",
              publication: "Research Institute",
              url: journalistUrl,
              excerpt: "A. Reporter writes from a progressive perspective.",
            },
          ],
          weighting: {
            articleWeight: 0.5,
            publicationHistory: 0.6,
            journalistWork: 0.4,
            comparableCoverage: 0,
            topicContext: 0,
            rationale: "The article and two distinct context sources carry equal weight.",
          },
        }),
      ],
    });
    const sourcesByQuery = new Map([
      [
        "Example News political orientation",
        {
          id: "publication",
          title: "Publication study",
          url: publicationUrl,
          content: "Example News is a conservative publication.",
          publishedAt: null,
          score: 0.9,
        },
      ],
      [
        "A. Reporter recurring political framing",
        {
          id: "journalist",
          title: "Journalist study",
          url: journalistUrl,
          content: "A. Reporter writes from a progressive perspective.",
          publishedAt: null,
          score: 0.9,
        },
      ],
      [
        "housing program comparable coverage",
        [
          {
            id: "current-article",
            title: request.article.title,
            url: request.article.canonicalUrl,
            content: request.article.paragraphs[0]!.text,
            publishedAt: request.article.publishedAt,
            score: 0.95,
          },
          {
            id: "comparison",
            title: "Related coverage",
            url: comparisonUrl,
            content: "The same outlet covered a related housing program.",
            publishedAt: null,
            score: 0.8,
          },
        ],
      ],
    ] satisfies Array<[string, ResearchSearchResult | ResearchSearchResult[]]>);
    const searchRequests: Array<{ query: string; excludeDomains: string[] }> = [];
    const search = vi.fn(async (searchRequest: { query: string; excludeDomains: string[] }) => {
      searchRequests.push(searchRequest);
      const { query } = searchRequest;
      const source = sourcesByQuery.get(query);
      return source ? (Array.isArray(source) ? source : [source]) : [];
    });
    const contents = vi.fn(async ({ urls }: { urls: string[] }) =>
      urls.flatMap((url) => {
        const source = [...sourcesByQuery.values()]
          .flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate]))
          .find((candidate) => candidate.url === url);
        return source ? [source] : [];
      }),
    );
    const provider = new AgenticAiSdkResearchProvider({
      model,
      searchProvider: { search, contents },
    });

    const result = await provider.analyzePoliticalContext(request, createFallbackDossier(request));

    expect(result.status).toBe("ready");
    expect(result.signals.map((signal) => signal.id)).toEqual([
      "publication-valid",
      "journalist-valid",
    ]);
    expect(result.signals.some((signal) => signal.id === "journalist-misattributed")).toBe(false);
    expect(searchRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: "Example News political orientation",
          excludeDomains: ["example.com"],
        }),
        expect.objectContaining({
          query: "A. Reporter recurring political framing",
          excludeDomains: [],
        }),
        expect.objectContaining({
          query: "housing program comparable coverage",
          excludeDomains: [],
        }),
      ]),
    );
    const readUrls = contents.mock.calls.flatMap(([contentsRequest]) => contentsRequest.urls);
    expect(readUrls).toContain(comparisonUrl);
    expect(readUrls).not.toContain(request.article.canonicalUrl);
  });

  it("uses a lean journalist budget and lets bias finish without unnecessary search", async () => {
    const journalistModel = new MockLanguageModelV4({
      doStream: [
        toolStream("searchWeb", "journalist-search", {
          queries: ["A. Reporter public journalism portfolio"],
          reason: "Find relevant public work by the named journalist.",
        }),
        textStream({
          status: "empty",
          summary: "No relevant public work was found.",
          findings: [],
          readerCopy: {
            lead: "No relevant public work was found.",
            findings: [],
          },
        }),
      ],
    });
    const journalistSearch = vi.fn(async (_searchRequest: { excludeDomains: string[] }) => []);
    const journalistProvider = new AgenticAiSdkResearchProvider({
      model: journalistModel,
      searchProvider: { search: journalistSearch },
    });

    await expect(
      journalistProvider.analyzeJournalistContext(request, createFallbackDossier(request)),
    ).resolves.toMatchObject({ status: "empty" });
    expect(journalistSearch).toHaveBeenCalledOnce();
    expect(journalistSearch.mock.calls[0]?.[0].excludeDomains).toEqual([]);

    const biasModel = new MockLanguageModelV4({
      doStream: textStream({
        status: "empty",
        summary: "No meaningful framing pattern stood out.",
        findings: [],
        readerCopy: {
          lead: "No meaningful framing pattern stood out.",
          findings: [],
        },
      }),
    });
    const biasSearch = vi.fn(async () => []);
    const biasProvider = new AgenticAiSdkResearchProvider({
      model: biasModel,
      searchProvider: { search: biasSearch },
    });

    await expect(
      biasProvider.analyzeBias(request, createFallbackDossier(request), []),
    ).resolves.toMatchObject({ status: "empty" });
    expect(biasSearch).not.toHaveBeenCalled();
  });

  it("surfaces a political-context failure reported by the recovery bundle", async () => {
    const provider = new AgenticAiSdkResearchProvider({
      model: new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("not used");
        },
      }),
      searchProvider: { search: async () => [] },
    });
    const internal = provider as unknown as {
      runAgent: () => Promise<never>;
      getContextFallback: () => Promise<unknown>;
    };
    internal.runAgent = vi.fn(async () => {
      throw new Error("primary political specialist failed");
    });
    internal.getContextFallback = vi.fn(async () => ({
      politicalContext: {
        status: "empty",
        summary: "No political context was produced.",
        signals: [],
      },
      journalistContext: {
        status: "empty",
        summary: "No journalist context was produced.",
        findings: [],
      },
      failures: {
        politicalContext: new Error("fallback political context failed"),
      },
    }));

    await expect(
      provider.analyzePoliticalContext(request, createFallbackDossier(request)),
    ).rejects.toMatchObject({
      name: "SpecialistResearchError",
      message: expect.stringContaining("fallback political context failed"),
    });
  });

  it("returns valid empty research sections when the specialist model fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("stream temporarily unavailable");
      },
    });
    const search = vi.fn(async () => []);
    const traces: string[] = [];
    const provider = new AgenticAiSdkResearchProvider({
      model,
      searchProvider: { search },
      onTrace: (trace) => traces.push(`${trace.section}:${trace.event}`),
    });
    const dossier = createFallbackDossier(request);

    const [journalist, supporting, contradicting, additionalContext] = await Promise.all([
      provider.analyzeJournalistContext(request, dossier),
      provider.analyzeEvidence("supporting", request, dossier),
      provider.analyzeEvidence("contradicting", request, dossier),
      provider.analyzeEvidence("additional-context", request, dossier),
    ]);

    expect(journalist).toMatchObject({ status: "empty", findings: [] });
    expect(supporting).toMatchObject({ status: "empty", sources: [] });
    expect(contradicting).toMatchObject({ status: "empty", sources: [] });
    expect(additionalContext).toMatchObject({ status: "empty", sources: [] });
    expect(traces.some((trace) => trace.endsWith(":fallback.started"))).toBe(true);
    consoleError.mockRestore();
  });

  it("does not retry a model hard timeout", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    const traces: string[] = [];
    const provider = new AgenticAiSdkResearchProvider({
      model,
      searchProvider: { search: async () => [] },
      onTrace: (trace) => traces.push(trace.event),
    });

    await expect(
      provider.analyzeBias(request, createFallbackDossier(request), []),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(traces).not.toContain("agent.retrying");
    consoleError.mockRestore();
  });

  it("enforces one total specialist deadline across queue and model work", async () => {
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) =>
        await new Promise((_, reject) => {
          const rejectForAbort = () =>
            reject(
              abortSignal?.reason instanceof Error
                ? abortSignal.reason
                : new DOMException("The operation was aborted.", "AbortError"),
            );
          if (abortSignal?.aborted) rejectForAbort();
          else abortSignal?.addEventListener("abort", rejectForAbort, { once: true });
        }),
    });
    const provider = new AgenticAiSdkResearchProvider({
      model,
      searchProvider: { search: async () => [] },
      specialistTimeoutMs: 30,
    });
    const startedAt = Date.now();

    await expect(
      provider.analyzeBias(request, createFallbackDossier(request), []),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
