import type { AnalysisEvent, AnalyzeRequest, ResearchClaim } from "@perspectica/contracts";
import { describe, expect, it, vi } from "vitest";
import { DemoArticleLensProvider, DemoResearchProvider } from "./demo";
import {
  extractFallbackClaims,
  createFallbackDossier,
  runAnalysis,
  type ContextResearchBundle,
  type EvidenceResearchBundle,
} from "./index";

const request: AnalyzeRequest = {
  client: { extensionVersion: "test" },
  article: {
    fingerprint: "fixture",
    canonicalUrl: "https://example.com/news/policy",
    title: "Council approves housing program",
    author: "Example Reporter",
    publication: "Example News",
    publishedAt: "2026-07-28T12:00:00.000Z",
    language: "en",
    contentType: "news",
    paragraphs: [
      {
        id: "paragraph-1",
        index: 0,
        kind: "paragraph",
        text: "The council approved a sweeping public housing investment intended to provide equal access across the city.",
        speaker: null,
      },
      {
        id: "paragraph-2",
        index: 1,
        kind: "paragraph",
        text: "Local participation will guide how the program is carried out in each neighborhood.",
        speaker: null,
      },
    ],
    links: [
      {
        id: "source-1",
        label: "Council record",
        url: "https://example.gov/council-record",
        paragraphId: "paragraph-1",
      },
    ],
    extraction: {
      extractorVersion: "test",
      extractedAt: "2026-07-28T12:00:00.000Z",
      wordCount: 30,
    },
  },
};

const emptyContextBundle: ContextResearchBundle = {
  politicalContext: {
    status: "empty",
    summary: "No reliable political context was found.",
    signals: [],
  },
  journalistContext: {
    status: "empty",
    summary: "No relevant public work was found.",
    findings: [],
    emptyReason: "no-verified-evidence",
  },
};

const emptyEvidenceBundle: EvidenceResearchBundle = {
  supporting: {
    status: "empty",
    summary: "No support.",
    sources: [],
    emptyReason: "no-verified-evidence",
  },
  contradicting: {
    status: "empty",
    summary: "No contradiction.",
    sources: [],
    emptyReason: "no-verified-evidence",
  },
  additionalContext: {
    status: "empty",
    summary: "No additional context.",
    sources: [],
    emptyReason: "no-verified-evidence",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("runAnalysis", () => {
  it("runs the six specialist surfaces and permits a context-led compass result", async () => {
    const calls: string[] = [];
    const dossier = createFallbackDossier(request);
    const events: AnalysisEvent[] = [];
    for await (const event of runAnalysis(request, {
      articleLens: {
        analyze: async () => ({
          compassEvidence: [],
          biasCandidates: [],
          dossier,
        }),
      },
      research: {
        contextBundle: async () => {
          throw new Error("Legacy context must not run");
        },
        evidenceBundle: async () => {
          throw new Error("Legacy evidence must not run");
        },
        analyzePoliticalContext: async (_request, _dossier, _signal, articleEvidence) => {
          calls.push("political-spectrum");
          expect(articleEvidence).toEqual([]);
          return {
            status: "ready",
            summary: "Independent research establishes a bounded historical pattern.",
            signals: [
              {
                id: "publication-right",
                sourceKind: "publication-history",
                subject: "Example News",
                score: 1.4,
                direction: "right",
                strength: 0.3,
                relevance: 0.9,
                explanation: "A media study identifies a durable market-oriented tradition.",
                sourceTitle: "Media study",
                publication: "Research Institute",
                url: "https://research.example/outlet-economic",
                excerpt: "The outlet has a durable market-oriented editorial tradition.",
              },
              {
                id: "journalist-right",
                sourceKind: "journalist-work",
                subject: "Example Reporter",
                score: 0.8,
                direction: "right",
                strength: 0.25,
                relevance: 0.8,
                explanation: "The same study documents a durable authority-oriented tradition.",
                sourceTitle: "Media study",
                publication: "Research Institute",
                url: "https://research.example/outlet-governance",
                excerpt: "The outlet has a durable conservative editorial tradition.",
              },
            ],
          };
        },
        analyzeJournalistContext: async () => {
          calls.push("journalist-context");
          return {
            status: "empty",
            summary: "No relevant public professional context was found.",
            findings: [],
            emptyReason: "no-verified-evidence",
          };
        },
        analyzeBias: async () => {
          calls.push("bias");
          return {
            status: "empty",
            summary: "No meaningful framing pattern stood out.",
            findings: [],
          };
        },
        analyzeEvidence: async (section) => {
          calls.push(section);
          return {
            status: "empty",
            summary: "No material result.",
            sources: [],
            emptyReason: "no-verified-evidence",
          };
        },
      },
      createId: () => "analysis-agentic-test",
    })) {
      events.push(event);
    }

    expect(new Set(calls)).toEqual(
      new Set([
        "political-spectrum",
        "journalist-context",
        "bias",
        "supporting",
        "contradicting",
        "additional-context",
      ]),
    );
    expect(events.filter((event) => event.type === "compass.ready")).toHaveLength(1);
    expect(events.some((event) => event.type === "compass.provisional")).toBe(false);
    expect(events.find((event) => event.type === "compass.ready")).toMatchObject({
      data: {
        basis: "context-led",
        confidence: "low",
      },
    });
  });

  it("removes reader copy for bias candidates rejected by exact-article validation", async () => {
    const validFinding = {
      id: "bias-valid",
      technique: "word-choice" as const,
      displayName: "Loaded wording",
      paragraphId: "paragraph-1",
      excerpt: "sweeping public housing investment",
      explanation: "The adjective presents the program as unusually broad in scope.",
      confidence: 0.86,
      relevance: 0.8,
      prominence: 0.75,
    };
    const rejectedFinding = {
      ...validFinding,
      id: "bias-rejected",
      excerpt: "language that does not appear in the article",
    };
    const events: AnalysisEvent[] = [];

    for await (const event of runAnalysis(request, {
      articleLens: {
        analyze: async () => ({
          compassEvidence: [],
          biasCandidates: [validFinding, rejectedFinding],
          dossier: createFallbackDossier(request),
        }),
      },
      research: {
        contextBundle: async () => emptyContextBundle,
        evidenceBundle: async () => emptyEvidenceBundle,
        analyzePoliticalContext: async () => emptyContextBundle.politicalContext,
        analyzeJournalistContext: async () => emptyContextBundle.journalistContext,
        analyzeBias: async () => ({
          status: "ready",
          summary: "Two possible framing choices were considered.",
          findings: [validFinding, rejectedFinding],
          readerCopy: {
            lead: "Two framing choices shape the article.",
            findings: [
              {
                id: "reader-valid",
                text: "The article describes the investment as unusually broad.",
                citationIds: ["bias-valid"],
                keySourceNote: null,
              },
              {
                id: "reader-rejected",
                text: "This sentence relies on evidence that does not appear in the article.",
                citationIds: ["bias-rejected"],
                keySourceNote: null,
              },
            ],
          },
          citations: [],
        }),
        analyzeEvidence: async (section) =>
          section === "additional-context"
            ? emptyEvidenceBundle.additionalContext
            : emptyEvidenceBundle[section],
      },
      createId: () => "analysis-bias-copy-test",
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "bias.ready")).toMatchObject({
      data: {
        findings: [{ id: "bias-valid" }],
        readerCopy: {
          lead: "The article includes a framing choice that may shape how the story is read.",
          findings: [{ id: "reader-valid", citationIds: ["bias-valid"] }],
        },
      },
    });
  });

  it("reconciles reader copy after the same source is assigned to a higher-priority lane", async () => {
    const sharedUrl = "https://records.example/shared";
    const uniqueUrl = "https://records.example/unique-support";
    const externalSource = (
      id: string,
      url: string,
      relationship: "supports" | "qualifies",
      explanation: string,
    ) => ({
      id,
      claimId: null,
      title: `${id} title`,
      publication: "Public Record",
      publishedAt: null,
      excerpt: `${id} exact excerpt`,
      relationship,
      relationshipExplanation: explanation,
      url,
      sourceType: "primary-record" as const,
      publicationContext: null,
    });
    const events: AnalysisEvent[] = [];

    for await (const event of runAnalysis(request, {
      articleLens: {
        analyze: async () => ({
          compassEvidence: [],
          biasCandidates: [],
          dossier: createFallbackDossier(request),
        }),
      },
      research: {
        contextBundle: async () => emptyContextBundle,
        evidenceBundle: async () => emptyEvidenceBundle,
        analyzePoliticalContext: async () => emptyContextBundle.politicalContext,
        analyzeJournalistContext: async () => emptyContextBundle.journalistContext,
        analyzeBias: async () => ({
          status: "empty",
          summary: "No meaningful framing pattern stood out.",
          findings: [],
          citations: [],
        }),
        analyzeEvidence: async (section) => {
          if (section === "contradicting") {
            return {
              status: "ready",
              summary: "The shared source qualifies a claim.",
              sources: [
                externalSource(
                  "shared-qualification",
                  sharedUrl,
                  "qualifies",
                  "The record narrows the article’s claim.",
                ),
              ],
              readerCopy: {
                lead: "The record qualifies a claim.",
                findings: [
                  {
                    id: "reader-shared-qualification",
                    text: "The record adds a concrete limitation.",
                    citationIds: ["shared-qualification"],
                    keySourceNote: null,
                  },
                ],
              },
            };
          }
          if (section === "supporting") {
            return {
              status: "ready",
              summary: "Two records support the article.",
              sources: [
                externalSource(
                  "shared-support",
                  sharedUrl,
                  "supports",
                  "The shared record corroborates one claim.",
                ),
                externalSource(
                  "unique-support",
                  uniqueUrl,
                  "supports",
                  "The independent record corroborates the remaining claim.",
                ),
              ],
              readerCopy: {
                lead: "Two records support separate claims in the article.",
                findings: [
                  {
                    id: "reader-shared-support",
                    text: "The shared record supports one claim.",
                    citationIds: ["shared-support"],
                    keySourceNote: null,
                  },
                  {
                    id: "reader-unique-support",
                    text: "The independent record supports another claim.",
                    citationIds: ["unique-support"],
                    keySourceNote: null,
                  },
                ],
              },
            };
          }
          return emptyEvidenceBundle.additionalContext;
        },
      },
      createId: () => "analysis-cross-lane-copy-test",
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "supporting.ready")).toMatchObject({
      data: {
        sources: [{ id: "unique-support" }],
        readerCopy: {
          lead: "Independent evidence supports important factual claims in the article.",
          findings: [{ id: "reader-unique-support", citationIds: ["unique-support"] }],
        },
      },
    });
  });

  it("streams context before Article Lens and supplies fallback claims to evidence research", async () => {
    const order: string[] = [];
    const evidenceClaims: ResearchClaim[][] = [];
    const lens = deferred<Awaited<ReturnType<DemoArticleLensProvider["analyze"]>>>();
    const events: AnalysisEvent[] = [];
    const collection = (async () => {
      for await (const event of runAnalysis(request, {
        articleLens: {
          analyze: () => {
            order.push("article-lens");
            return lens.promise;
          },
        },
        research: {
          contextBundle: async () => {
            order.push("context");
            return emptyContextBundle;
          },
          evidenceBundle: async (_request, claims) => {
            order.push("evidence");
            evidenceClaims.push(claims);
            return emptyEvidenceBundle;
          },
        },
        createId: () => "analysis-early-context-test",
      })) {
        events.push(event);
      }
    })();

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "journalistContext.ready")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "supporting.ready")).toBe(true);
    });
    expect(events.some((event) => event.type === "bias.ready")).toBe(false);
    expect(evidenceClaims[0]?.length).toBeGreaterThan(0);
    expect(evidenceClaims[0]?.[0]?.id).toMatch(/^fallback-claim-/);
    lens.resolve({
      compassEvidence: [],
      biasCandidates: [],
    });
    await collection;

    expect(order).toEqual(["context", "article-lens", "evidence"]);
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: "analysis.completed",
      data: { status: "complete", failedSections: [] },
    });
  });

  it("emits the complete demo pipeline with one terminal compass result", async () => {
    const events: AnalysisEvent[] = [];
    for await (const event of runAnalysis(request, {
      articleLens: new DemoArticleLensProvider(),
      research: new DemoResearchProvider(),
      createId: () => "analysis-test",
    })) {
      events.push(event);
    }

    expect(events.at(0)?.type).toBe("analysis.started");
    expect(events.at(-1)).toMatchObject({
      type: "analysis.completed",
      data: { status: "complete" },
    });
    expect(events.filter((event) => event.type === "compass.ready")).toHaveLength(1);
    expect(events.filter((event) => event.type === "bias.ready")).toHaveLength(1);
    expect(events.filter((event) => event.type === "supporting.ready")).toHaveLength(1);
    expect(events.filter((event) => event.type === "contradicting.ready")).toHaveLength(1);
    expect(events.filter((event) => event.type === "additionalContext.ready")).toHaveLength(1);
  });

  it("continues claim-based research after Article Lens fails and marks the report partial", async () => {
    const evidenceClaims: ResearchClaim[][] = [];
    const events: AnalysisEvent[] = [];
    for await (const event of runAnalysis(request, {
      articleLens: {
        analyze: async () => {
          throw new Error("The operation was aborted due to timeout");
        },
      },
      research: {
        contextBundle: async () => emptyContextBundle,
        evidenceBundle: async (_request, claims) => {
          evidenceClaims.push(claims);
          return emptyEvidenceBundle;
        },
      },
      createId: () => "analysis-lens-failure-test",
    })) {
      events.push(event);
    }

    expect(evidenceClaims[0]?.length).toBeGreaterThan(0);
    expect(
      events.filter(
        (event) =>
          event.type === "section.failed" &&
          (event.data.section === "compass" || event.data.section === "bias"),
      ),
    ).toHaveLength(2);
    expect(
      events.find((event) => event.type === "section.failed" && event.data.section === "compass"),
    ).toMatchObject({
      data: { message: "This section took longer than expected. Try again." },
    });
    expect(events.at(-1)).toMatchObject({
      type: "analysis.completed",
      data: {
        status: "partial",
        failedSections: ["compass", "bias"],
      },
    });
  });

  it("isolates one failed evidence lane and completes the remaining report", async () => {
    const events: AnalysisEvent[] = [];
    for await (const event of runAnalysis(request, {
      articleLens: new DemoArticleLensProvider(),
      research: {
        contextBundle: async () => emptyContextBundle,
        evidenceBundle: async () => ({
          ...emptyEvidenceBundle,
          failures: { supporting: new Error("Supporting search unavailable") },
        }),
      },
      createId: () => "analysis-one-lane-failure-test",
    })) {
      events.push(event);
    }

    expect(
      events.some(
        (event) => event.type === "section.failed" && event.data.section === "supporting",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "contradicting.ready")).toBe(true);
    expect(events.some((event) => event.type === "additionalContext.ready")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "analysis.completed",
      data: { status: "partial", failedSections: ["supporting"] },
    });
  });

  it("emits completed bundles in arrival order and distinguishes provisional compass output", async () => {
    const context = deferred<ContextResearchBundle>();
    const evidence = deferred<EvidenceResearchBundle>();
    const events: AnalysisEvent[] = [];
    const collection = (async () => {
      for await (const event of runAnalysis(request, {
        articleLens: new DemoArticleLensProvider(),
        research: {
          contextBundle: () => context.promise,
          evidenceBundle: () => evidence.promise,
        },
        createId: () => "analysis-parallel-test",
      })) {
        events.push(event);
      }
    })();

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "compass.provisional")).toBe(true);
    });

    evidence.resolve(emptyEvidenceBundle);
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "supporting.ready")).toBe(true);
    });
    expect(events.some((event) => event.type === "journalistContext.ready")).toBe(false);

    context.resolve(emptyContextBundle);
    await collection;

    expect(
      events
        .filter((event) =>
          [
            "compass.provisional",
            "supporting.ready",
            "journalistContext.ready",
            "compass.ready",
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual([
      "compass.provisional",
      "supporting.ready",
      "journalistContext.ready",
      "compass.ready",
    ]);
  });
});

describe("extractFallbackClaims", () => {
  it("selects bounded exact article sentences for research", () => {
    const claims = extractFallbackClaims(request);

    expect(claims.length).toBeGreaterThan(0);
    expect(claims.length).toBeLessThanOrEqual(4);
    expect(
      request.article.paragraphs.some((paragraph) =>
        paragraph.text.includes(claims[0]?.text ?? "__missing__"),
      ),
    ).toBe(true);
  });
});
