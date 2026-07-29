import type { AnalyzeRequest, ResearchClaim } from "@perspectica/contracts";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createResearchBrief } from "./index";
import {
  AiSdkResearchProvider,
  buildContextBundlePrompt,
  buildEvidencePrompt,
  buildResearchQuery,
  type ResearchSearchProvider,
  type ResearchSearchRequest,
  type ResearchSearchResult,
} from "./research-ai-sdk";

const request: AnalyzeRequest = {
  article: {
    fingerprint: "research-test",
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

const claims: ResearchClaim[] = [
  {
    id: "claim-1",
    text: "The program will serve 1,000 residents.",
    paragraphIds: ["p-1"],
    importance: 0.9,
    queryHints: ["housing program 1000 residents"],
  },
];

function streamResult(output: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text-1" },
        {
          type: "text-delta" as const,
          id: "text-1",
          delta: JSON.stringify(output),
        },
        { type: "text-end" as const, id: "text-1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: {
              total: 20,
              noCache: 20,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: {
              total: 30,
              text: 30,
              reasoning: 0,
            },
          },
        },
      ],
    }),
  };
}

function streamedModel(output: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: streamResult(output),
  });
}

function streamedOutputsModel(outputs: unknown[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: outputs.map(streamResult),
  });
}

function source(id: string, url: string, content: string): ResearchSearchResult {
  return {
    id,
    title: `${id} title`,
    url,
    content,
    publishedAt: null,
    score: 0.9,
  };
}

const supportSource = source(
  "support",
  "https://example.gov/housing-program",
  "The program is designed to serve 1,000 residents.",
);
const qualificationSource = source(
  "qualification",
  "https://independent.example/qualification",
  "Only 700 places are funded in the first year.",
);
const contextSource = source(
  "context",
  "https://history.example/housing-timeline",
  "The program replaces a pilot created in 2022.",
);

function evidenceOutput() {
  return {
    supporting: {
      status: "ready",
      summary: "A primary record supports the capacity claim.",
      sources: [
        {
          id: "support-1",
          claimId: "claim-1",
          title: supportSource.title,
          publication: "Example City",
          publishedAt: null,
          excerpt: supportSource.content,
          relationship: "supports",
          relationshipExplanation: "The primary record states the same capacity.",
          url: supportSource.url,
          sourceType: "primary-record",
          publicationContext: "Official city record",
        },
      ],
    },
    contradicting: {
      status: "ready",
      summary: "Reporting qualifies the first-year capacity.",
      sources: [
        {
          id: "qualification-1",
          claimId: "claim-1",
          title: qualificationSource.title,
          publication: "Independent News",
          publishedAt: null,
          excerpt: qualificationSource.content,
          relationship: "qualifies",
          relationshipExplanation: "The first-year funding is narrower than the headline capacity.",
          url: qualificationSource.url,
          sourceType: "independent-reporting",
          publicationContext: null,
        },
      ],
    },
    additionalContext: {
      status: "ready",
      summary: "The timeline explains the program's origin.",
      sources: [
        {
          id: "context-1",
          claimId: "claim-1",
          title: contextSource.title,
          publication: "Housing Archive",
          publishedAt: null,
          excerpt: contextSource.content,
          relationship: "adds-context",
          relationshipExplanation: "The source establishes the pilot-program timeline.",
          url: contextSource.url,
          sourceType: "primary-record",
          publicationContext: null,
        },
      ],
    },
  };
}

function streamedEvidenceModel(output: ReturnType<typeof evidenceOutput>): MockLanguageModelV4 {
  return streamedOutputsModel([output.supporting, output.contradicting, output.additionalContext]);
}

describe("AiSdkResearchProvider evidence bundle", () => {
  it("retrieves and synthesizes three isolated evidence lanes in parallel", async () => {
    const search = vi.fn(async (searchRequest: ResearchSearchRequest) => {
      if (searchRequest.query.includes("disputed corrected")) return [qualificationSource];
      if (searchRequest.query.includes("essential background")) return [contextSource];
      return [supportSource];
    });
    const model = streamedEvidenceModel(evidenceOutput());
    const provider = new AiSdkResearchProvider({
      model,
      searchProvider: { search },
    });

    const result = await provider.evidenceBundle(request, claims);

    expect(result.supporting.sources).toHaveLength(1);
    expect(result.contradicting.sources).toHaveLength(1);
    expect(result.additionalContext.sources).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(3);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls.map((call) => call.maxOutputTokens)).toEqual([900, 900, 650]);
    expect(JSON.stringify(model.doStreamCalls[0]?.responseFormat)).not.toContain('"format":"uri"');
  });

  it("does not search or call the model without researchable claims", async () => {
    const model = new MockLanguageModelV4();
    const search = vi.fn();
    const provider = new AiSdkResearchProvider({
      model,
      searchProvider: { search },
    });

    await expect(provider.evidenceBundle(request, [])).resolves.toMatchObject({
      supporting: { status: "empty", emptyReason: "no-claims" },
      contradicting: { status: "empty", emptyReason: "no-claims" },
      additionalContext: { status: "empty", emptyReason: "no-claims" },
    });
    expect(search).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("keeps a repeated source only in the higher-priority contradicting lane", async () => {
    const duplicateOutput = evidenceOutput();
    duplicateOutput.supporting.sources[0] = {
      ...duplicateOutput.supporting.sources[0]!,
      title: qualificationSource.title,
      excerpt: qualificationSource.content,
      url: qualificationSource.url,
    };
    const provider = new AiSdkResearchProvider({
      model: streamedEvidenceModel(duplicateOutput),
      searchProvider: {
        search: async () => [qualificationSource, contextSource],
      },
    });

    const result = await provider.evidenceBundle(request, claims);

    expect(result.supporting).toMatchObject({
      status: "empty",
      sources: [],
    });
    expect(result.contradicting.sources).toHaveLength(1);
  });

  it("accepts source excerpts after harmless punctuation normalization", async () => {
    const normalizedOutput = evidenceOutput();
    normalizedOutput.supporting.sources[0]!.excerpt =
      "The program is designed to serve 1,000 residents.";
    const provider = new AiSdkResearchProvider({
      model: streamedEvidenceModel(normalizedOutput),
      searchProvider: {
        search: async (searchRequest) =>
          searchRequest.query.includes("disputed corrected")
            ? [qualificationSource]
            : searchRequest.query.includes("essential background")
              ? [contextSource]
              : [
                  source(
                    "support",
                    supportSource.url,
                    "The program is designed to serve 1,000 residents.\u00a0",
                  ),
                ],
      },
    });

    const result = await provider.evidenceBundle(request, claims);

    expect(result.supporting.sources).toHaveLength(1);
  });

  it("isolates a failed search lane while preserving the other evidence sections", async () => {
    const output = evidenceOutput();
    const provider = new AiSdkResearchProvider({
      model: streamedOutputsModel([output.supporting, output.additionalContext]),
      searchProvider: {
        search: async (searchRequest) => {
          if (searchRequest.query.includes("disputed corrected")) {
            throw new Error("Contradiction search unavailable");
          }
          if (searchRequest.query.includes("essential background")) return [contextSource];
          return [supportSource];
        },
      },
    });

    const result = await provider.evidenceBundle(request, claims);

    expect(result.supporting.sources).toHaveLength(1);
    expect(result.additionalContext.sources).toHaveLength(1);
    expect(result.contradicting.sources).toEqual([]);
    expect(result.failures?.contradicting).toBeInstanceOf(Error);
    expect(result.failures?.supporting).toBeUndefined();
  });

  it("isolates a failed synthesis lane while preserving completed evidence", async () => {
    const output = evidenceOutput();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let callIndex = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const current = callIndex;
        callIndex += 1;
        if (current === 1) {
          throw new Error("Contradiction synthesis timed out");
        }
        return current === 0
          ? streamResult(output.supporting)
          : streamResult(output.additionalContext);
      },
    });
    const provider = new AiSdkResearchProvider({
      model,
      searchProvider: {
        search: async (searchRequest) => {
          if (searchRequest.query.includes("disputed corrected")) return [qualificationSource];
          if (searchRequest.query.includes("essential background")) return [contextSource];
          return [supportSource];
        },
      },
    });

    const result = await provider.evidenceBundle(request, claims);

    expect(result.supporting.sources).toHaveLength(1);
    expect(result.additionalContext.sources).toHaveLength(1);
    expect(result.contradicting.sources).toEqual([]);
    expect(result.failures?.contradicting).toBeInstanceOf(Error);
    consoleError.mockRestore();
  });

  it("defines narrow and non-overlapping lane responsibilities", () => {
    const brief = createResearchBrief(request, claims);
    const contradictingPrompt = buildEvidencePrompt("contradicting", brief, [qualificationSource]);
    const contextPrompt = buildEvidencePrompt("additional-context", brief, [contextSource]);

    expect(contradictingPrompt).toContain("not a second supporting section");
    expect(contradictingPrompt).toContain("silence, omission, narrower coverage");
    expect(contextPrompt).toContain("definition, timeline, institutional process");
  });
});

describe("AiSdkResearchProvider context bundle", () => {
  it("grounds political and journalist context in one shared model call", async () => {
    const publicationExcerpt =
      "The outlet has maintained a durable conservative editorial orientation.";
    const journalistExcerpt =
      "The reporter's recent work repeatedly examines market-oriented policy proposals.";
    const output = {
      politicalContext: {
        status: "ready",
        summary: "Independent sources provide a weak contextual prior.",
        signals: [
          {
            id: "publication-right",
            sourceKind: "publication-history",
            subject: "Example News",
            score: 1.4,
            direction: "right",
            strength: 0.35,
            relevance: 0.9,
            explanation: "The source documents a durable conservative orientation.",
            sourceTitle: "Media orientation study",
            publication: "Research Institute",
            url: "https://research.example/media-orientation",
            excerpt: publicationExcerpt,
          },
        ],
      },
      journalistContext: {
        status: "ready",
        summary: "The reporter has relevant public professional work.",
        findings: [
          {
            id: "journalist-work",
            summary: "The reporter has repeatedly covered market-oriented policy.",
            relevanceExplanation: "That recurring beat is relevant to the current policy story.",
            sourceTitle: "Reporter archive",
            publication: "Archive",
            url: "https://archive.example/reporter",
            excerpt: journalistExcerpt,
          },
        ],
      },
    };
    const search = vi.fn(async (searchRequest: ResearchSearchRequest) =>
      searchRequest.query.includes("editorial political leaning")
        ? [source("publication", "https://research.example/media-orientation", publicationExcerpt)]
        : [source("journalist", "https://archive.example/reporter", journalistExcerpt)],
    );
    const model = streamedModel(output);
    const provider = new AiSdkResearchProvider({
      model,
      searchProvider: { search },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext.signals).toHaveLength(1);
    expect(result.journalistContext.findings).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(2);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("preserves publication context when journalist search fails", async () => {
    const publicationExcerpt =
      "The outlet has maintained a durable conservative editorial orientation.";
    const output = {
      politicalContext: {
        status: "ready",
        summary: "Independent sources provide a weak contextual prior.",
        signals: [
          {
            id: "publication-right",
            sourceKind: "publication-history",
            subject: "Example News",
            score: 1.4,
            direction: "right",
            strength: 0.35,
            relevance: 0.9,
            explanation: "The source documents a durable conservative orientation.",
            sourceTitle: "Media orientation study",
            publication: "Research Institute",
            url: "https://research.example/media-orientation",
            excerpt: publicationExcerpt,
          },
        ],
      },
      journalistContext: {
        status: "empty",
        summary: "No verified journalist context.",
        findings: [],
      },
    };
    const provider = new AiSdkResearchProvider({
      model: streamedModel(output),
      searchProvider: {
        search: async (searchRequest) => {
          if (!searchRequest.query.includes("editorial political leaning")) {
            throw new Error("Journalist search unavailable");
          }
          return [
            source("publication", "https://research.example/media-orientation", publicationExcerpt),
          ];
        },
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext.signals).toHaveLength(1);
    expect(result.failures?.journalistContext).toBeInstanceOf(Error);
  });

  it("rejects syndicated aggregator copies as journalist context", async () => {
    const mirrorExcerpt =
      "The effort is the latest example of Washington's approach to technology threats.";
    const output = {
      politicalContext: {
        status: "empty",
        summary: "No verified political context.",
        signals: [],
      },
      journalistContext: {
        status: "ready",
        summary: "The reporter covered a related restriction.",
        findings: [
          {
            id: "aol-mirror",
            summary: "The reporter covered another technology restriction.",
            relevanceExplanation: "The subject overlaps with the current article.",
            sourceTitle: "Syndicated Reuters copy",
            publication: "AOL",
            url: "https://www.aol.com/articles/exclusive-us-working-ban-100540000.html",
            excerpt: mirrorExcerpt,
          },
        ],
      },
    };
    const provider = new AiSdkResearchProvider({
      model: streamedModel(output),
      searchProvider: {
        search: async (searchRequest) =>
          searchRequest.query.includes("editorial political leaning")
            ? []
            : [
                source(
                  "aol-mirror",
                  "https://www.aol.com/articles/exclusive-us-working-ban-100540000.html",
                  mirrorExcerpt,
                ),
              ],
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.journalistContext).toMatchObject({
      status: "empty",
      findings: [],
      emptyReason: "no-verified-evidence",
    });
  });

  it("rejects a political-context score unsupported by the cited excerpt", async () => {
    const publicationExcerpt = "The outlet was founded in 1990.";
    const output = {
      politicalContext: {
        status: "ready",
        summary: "The outlet has a market-oriented history.",
        signals: [
          {
            id: "unsupported-right",
            sourceKind: "publication-history",
            subject: "Example News",
            score: 1.5,
            direction: "right",
            strength: 0.4,
            relevance: 0.9,
            explanation: "The source documents a market-oriented history.",
            sourceTitle: "Outlet history",
            publication: "Media Archive",
            url: "https://archive.example/outlet-history",
            excerpt: publicationExcerpt,
          },
        ],
      },
      journalistContext: {
        status: "empty",
        summary: "No verified journalist context.",
        findings: [],
      },
    };
    const provider = new AiSdkResearchProvider({
      model: streamedModel(output),
      searchProvider: {
        search: async (searchRequest) =>
          searchRequest.query.includes("editorial political leaning")
            ? [source("publication", "https://archive.example/outlet-history", publicationExcerpt)]
            : [],
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext).toMatchObject({
      status: "empty",
      signals: [],
    });
  });

  it("keeps the adopted spectrum and contextual boundary explicit", () => {
    const prompt = buildContextBundlePrompt(createResearchBrief(request, claims), [], []);

    expect(prompt).toContain("The political scale is far left (-3)");
    expect(prompt).toContain("Center is a valid result");
    expect(prompt).toContain("never proof of what the current article says");
    expect(prompt).toContain("Do not infer politics from a topic assignment");
  });
});

describe("research queries", () => {
  it("focuses evidence retrieval on the strongest claims", () => {
    const brief = createResearchBrief(request, [
      ...claims,
      {
        ...claims[0]!,
        id: "claim-2",
        text: "A secondary detail",
        queryHints: ["secondary detail"],
        importance: 0.8,
      },
      {
        ...claims[0]!,
        id: "claim-3",
        text: "A low-priority detail",
        queryHints: ["low priority should be omitted"],
        importance: 0.1,
      },
    ]);

    const query = buildResearchQuery("supporting", brief);
    expect(query).toContain("housing program 1000 residents");
    expect(query).toContain("secondary detail");
    expect(query).not.toContain("low priority should be omitted");
  });
});
