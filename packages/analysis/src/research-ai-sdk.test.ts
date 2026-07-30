import type { AnalyzeRequest, ResearchClaim } from "@perspectica/contracts";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createResearchBrief } from "./index";
import {
  AiSdkResearchProvider,
  buildContextBundlePrompt,
  buildEvidenceBundlePrompt,
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
  return streamedModel(output);
}

describe("AiSdkResearchProvider evidence bundle", () => {
  it("retrieves three isolated evidence lanes in parallel and synthesizes them once", async () => {
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
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(2_400);
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

  it("keeps native search notes citeable without treating them as quotations", async () => {
    const noteSource: ResearchSearchResult = {
      ...supportSource,
      content:
        "Web-search summary: the city record says the housing program is designed for 1,000 residents.",
      contentKind: "search-note",
    };
    const output = evidenceOutput();
    output.supporting.sources[0]!.excerpt = "A sentence that was never fetched from the page.";
    output.supporting.sources[0]!.relationshipExplanation =
      "The city record says the program is designed for 1,000 residents.";
    const provider = new AiSdkResearchProvider({
      model: streamedEvidenceModel(output),
      searchProvider: {
        search: async (searchRequest) =>
          searchRequest.query.includes("disputed corrected")
            ? [qualificationSource]
            : searchRequest.query.includes("essential background")
              ? [contextSource]
              : [noteSource],
      },
    });

    const result = await provider.evidenceBundle(request, claims);

    expect(result.supporting.sources).toEqual([
      expect.objectContaining({
        url: supportSource.url,
        citationKind: "search-summary",
        excerpt: null,
      }),
    ]);
  });

  it("rejects a search-note relationship that invents details absent from the note", async () => {
    const noteSource: ResearchSearchResult = {
      ...supportSource,
      content:
        "Web-search summary: the city record says the housing program is designed for 1,000 residents.",
      contentKind: "search-note",
    };
    const output = evidenceOutput();
    output.supporting.sources[0]!.excerpt = "Purported page text that must not be rendered.";
    output.supporting.sources[0]!.relationshipExplanation =
      "The record guarantees permanent funding for ten years.";
    const provider = new AiSdkResearchProvider({
      model: streamedEvidenceModel(output),
      searchProvider: {
        search: async (searchRequest) =>
          searchRequest.query.includes("disputed corrected")
            ? [qualificationSource]
            : searchRequest.query.includes("essential background")
              ? [contextSource]
              : [noteSource],
      },
    });

    const result = await provider.evidenceBundle(request, claims);

    expect(result.supporting).toMatchObject({
      status: "empty",
      sources: [],
      emptyReason: "no-verified-evidence",
    });
  });

  it("isolates a failed search lane while preserving the other evidence sections", async () => {
    const output = evidenceOutput();
    const provider = new AiSdkResearchProvider({
      model: streamedModel(output),
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

  it("records one failed bundle synthesis against each lane that had sources", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("Bundle synthesis timed out");
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

    expect(result.supporting.sources).toEqual([]);
    expect(result.contradicting.sources).toEqual([]);
    expect(result.additionalContext.sources).toEqual([]);
    expect(result.failures?.supporting).toBeInstanceOf(Error);
    expect(result.failures?.contradicting).toBeInstanceOf(Error);
    expect(result.failures?.additionalContext).toBeInstanceOf(Error);
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

  it("keeps all source pools separated in the combined synthesis prompt", () => {
    const brief = createResearchBrief(request, claims);
    const prompt = buildEvidenceBundlePrompt(brief, {
      supporting: [supportSource],
      contradicting: [qualificationSource],
      additionalContext: [contextSource],
    });

    expect(prompt).toContain("<supporting-sources>");
    expect(prompt).toContain("<contradicting-sources>");
    expect(prompt).toContain("<additional-context-sources>");
    expect(prompt).toContain("Never move a source between pools");
    expect(prompt).toContain("search-note");
    expect(prompt).toContain("set excerpt to null");
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

  it("uses attributed search summaries for context without exposing a source quote", async () => {
    const publicationNote =
      "Independent media research describes Example News as a conservative, right-leaning outlet.";
    const journalistNote =
      "The reporter archive shows recurring public work about market-oriented housing policy.";
    const output = {
      politicalContext: {
        status: "ready",
        summary: "Independent research provides a weak contextual prior.",
        signals: [
          {
            id: "publication-note",
            sourceKind: "publication-history",
            subject: "Example News",
            score: 1.2,
            direction: "right",
            strength: 0.3,
            relevance: 0.8,
            explanation: "Independent research describes a durable right-leaning orientation.",
            sourceTitle: "Media research",
            publication: "Research Institute",
            url: "https://research.example/native-note",
            excerpt: "Purported page text that must not be rendered.",
          },
        ],
      },
      journalistContext: {
        status: "ready",
        summary: "The reporter has relevant public professional work.",
        findings: [
          {
            id: "journalist-note",
            summary: "The reporter repeatedly covers market-oriented housing policy.",
            relevanceExplanation: "That recurring subject is relevant to this article.",
            sourceTitle: "Reporter archive",
            publication: "Archive",
            url: "https://archive.example/native-note",
            excerpt: "Another purported quote that must not be rendered.",
          },
        ],
      },
    };
    const provider = new AiSdkResearchProvider({
      model: streamedModel(output),
      searchProvider: {
        search: async (searchRequest) =>
          searchRequest.query.includes("editorial political leaning")
            ? [
                {
                  ...source(
                    "publication-note",
                    "https://research.example/native-note",
                    publicationNote,
                  ),
                  contentKind: "search-note",
                },
              ]
            : [
                {
                  ...source(
                    "journalist-note",
                    "https://archive.example/native-note",
                    journalistNote,
                  ),
                  contentKind: "search-note",
                },
              ],
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext.signals[0]).toMatchObject({
      citationKind: "search-summary",
      excerpt: null,
    });
    expect(result.journalistContext.findings[0]).toMatchObject({
      citationKind: "search-summary",
      excerpt: null,
    });
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

  it("records a publication-search failure alongside partial journalist context", async () => {
    const journalistExcerpt = "The reporter has covered housing policy for several years.";
    const model = streamedModel({
      politicalContext: {
        status: "empty",
        summary: "No verified publication context.",
        signals: [],
      },
      journalistContext: {
        status: "ready",
        summary: "The reporter has relevant public work.",
        findings: [
          {
            id: "journalist-work",
            summary: "The reporter has covered housing policy for several years.",
            relevanceExplanation: "That recurring subject is relevant to this article.",
            sourceTitle: "Reporter archive",
            publication: "Archive",
            url: "https://archive.example/reporter",
            excerpt: journalistExcerpt,
          },
        ],
      },
    });
    const provider = new AiSdkResearchProvider({
      model,
      searchProvider: {
        search: async (searchRequest) => {
          if (searchRequest.query.includes("editorial political leaning")) {
            throw new Error("Publication search unavailable");
          }
          return [source("journalist", "https://archive.example/reporter", journalistExcerpt)];
        },
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext.signals).toEqual([]);
    expect(result.journalistContext.findings).toHaveLength(1);
    expect(result.failures?.politicalContext).toBeInstanceOf(Error);
    expect(result.failures?.journalistContext).toBeUndefined();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("retains both search diagnostics when neither context source pool has results", async () => {
    const model = streamedModel({});
    const provider = new AiSdkResearchProvider({
      model,
      searchProvider: {
        search: async (searchRequest) => {
          throw new Error(
            searchRequest.query.includes("editorial political leaning")
              ? "Publication search unavailable"
              : "Journalist search unavailable",
          );
        },
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext.signals).toEqual([]);
    expect(result.journalistContext.findings).toEqual([]);
    expect(result.failures?.politicalContext).toBeInstanceOf(Error);
    expect(result.failures?.journalistContext).toBeInstanceOf(Error);
    expect(model.doStreamCalls).toHaveLength(0);
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

  it("rejects personal and social-media hosts as journalist evidence", async () => {
    const linkedinExcerpt = "A profile lists the reporter's housing-policy work.";
    const youtubeExcerpt = "A channel description discusses the reporter's recent work.";
    const output = {
      politicalContext: {
        status: "empty",
        summary: "No verified political context.",
        signals: [],
      },
      journalistContext: {
        status: "ready",
        summary: "Social profiles describe the reporter's work.",
        findings: [
          {
            id: "linkedin-profile",
            summary: "A profile describes the reporter's housing-policy work.",
            relevanceExplanation: "The subject overlaps with the current article.",
            sourceTitle: "Reporter profile",
            publication: "LinkedIn",
            url: "https://www.linkedin.com/in/a-reporter",
            excerpt: linkedinExcerpt,
          },
          {
            id: "youtube-channel",
            summary: "A channel describes the reporter's recent work.",
            relevanceExplanation: "The subject overlaps with the current article.",
            sourceTitle: "Reporter channel",
            publication: "YouTube",
            url: "https://youtube.com/@a-reporter",
            excerpt: youtubeExcerpt,
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
                  "linkedin-profile",
                  "https://www.linkedin.com/in/a-reporter",
                  linkedinExcerpt,
                ),
                source("youtube-channel", "https://youtube.com/@a-reporter", youtubeExcerpt),
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

  it("rejects social-media sources for political journalist-work signals", async () => {
    const socialExcerpt = "The reporter describes their work as conservative commentary.";
    const output = {
      politicalContext: {
        status: "ready",
        summary: "A social profile claims an ideological orientation.",
        signals: [
          {
            id: "social-right",
            sourceKind: "journalist-work",
            subject: "A. Reporter",
            score: 1.2,
            direction: "right",
            strength: 0.25,
            relevance: 0.8,
            explanation: "The profile describes the reporter's work as conservative.",
            sourceTitle: "Reporter post",
            publication: "X",
            url: "https://x.com/a-reporter/status/123",
            excerpt: socialExcerpt,
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
            ? []
            : [source("social-right", "https://x.com/a-reporter/status/123", socialExcerpt)],
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext).toMatchObject({
      status: "empty",
      signals: [],
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

  it("does not treat a negated political label as directional evidence", async () => {
    const publicationExcerpt =
      "The independent assessment says Example News is not right-leaning and instead rates it centrist.";
    const output = {
      politicalContext: {
        status: "ready",
        summary: "The assessment explicitly rates the outlet as centrist.",
        signals: [
          {
            id: "negated-right",
            sourceKind: "publication-history",
            subject: "Example News",
            score: 1.2,
            direction: "right",
            strength: 0.35,
            relevance: 0.9,
            explanation: "The assessment describes the outlet as right-leaning.",
            sourceTitle: "Outlet assessment",
            publication: "Media Research",
            url: "https://research.example/outlet-assessment",
            excerpt: publicationExcerpt,
          },
          {
            id: "explicit-center",
            sourceKind: "publication-history",
            subject: "Example News",
            score: 0,
            direction: "center",
            strength: 0.3,
            relevance: 0.9,
            explanation: "The assessment explicitly rates the outlet as centrist.",
            sourceTitle: "Outlet assessment",
            publication: "Media Research",
            url: "https://research.example/outlet-assessment",
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
            ? [
                source(
                  "publication",
                  "https://research.example/outlet-assessment",
                  publicationExcerpt,
                ),
              ]
            : [],
      },
    });

    const result = await provider.contextBundle(request);

    expect(result.politicalContext.signals).toEqual([
      expect.objectContaining({
        id: "explicit-center",
        direction: "center",
        score: 0,
      }),
    ]);
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
  it("shares claim-linked article passages without exceeding the context budget", () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) => ({
      id: `p-${index + 1}`,
      index,
      kind: "paragraph" as const,
      speaker: null,
      text: `${index === 17 ? "Priority passage. " : ""}${"context ".repeat(120)}`,
    }));
    const brief = createResearchBrief(
      {
        ...request,
        article: {
          ...request.article,
          paragraphs,
        },
      },
      [
        {
          ...claims[0]!,
          paragraphIds: ["p-18"],
        },
      ],
    );

    expect(brief.passages[0]?.id).toBe("p-18");
    expect(brief.modelContext).toContain("Priority passage.");
    expect(
      brief.passages.reduce((total, passage) => total + passage.text.length, 0),
    ).toBeLessThanOrEqual(4_800);
  });

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
