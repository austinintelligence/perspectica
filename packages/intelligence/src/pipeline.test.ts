import { ArticleDocumentSchema } from "@perspectica/contracts";
import type { EvidenceBatch, RetrievalPlan } from "@perspectica/contracts/evidence";
import { describe, expect, it } from "vitest";
import {
  analyzeArticle,
  resolveAnalysisBudget,
  retryArticleSections,
  type AnalysisArtifacts,
} from "./index";
import type { EvidenceAdjudicator } from "./evidence/adjudication";

function article() {
  return ArticleDocumentSchema.parse({
    fingerprint: "article-fixture-v2",
    canonicalUrl: "https://example.com/story",
    title: "City council approves a public housing plan",
    author: "Riley Reporter",
    publication: "Example News",
    publishedAt: null,
    language: "en",
    contentType: "news",
    paragraphs: [
      {
        id: "p-1",
        index: 0,
        kind: "paragraph",
        speaker: null,
        text: "The city council approved a public housing investment after a 2026 vote.",
      },
      {
        id: "p-2",
        index: 1,
        kind: "paragraph",
        speaker: null,
        text: "Officials said the program will reduce unequal access to housing and create 2,000 units.",
      },
      {
        id: "p-3",
        index: 2,
        kind: "quote",
        speaker: "Maya Chen",
        text: "Local participation will guide how the program is carried out in each neighborhood.",
      },
    ],
    links: [
      { id: "link-1", label: "Public record", url: "https://city.gov/record", paragraphId: "p-1" },
    ],
    extraction: {
      extractorVersion: "test",
      extractedAt: "2026-08-02T12:00:00.000Z",
      wordCount: 34,
      articleStatus: "article",
      contentChars: 250,
      contentTruncated: false,
    },
  });
}

function retriever() {
  return {
    async *retrieve(plan: RetrievalPlan, _signal: AbortSignal): AsyncIterable<EvidenceBatch> {
      for (const [index, mission] of plan.missions.entries()) {
        const content = `Independent record ${index + 1} confirms: The city council approved a public housing investment after a 2026 vote.`;
        yield {
          missionId: mission.id,
          provider: "exa",
          searched: true,
          cacheHit: false,
          durationMs: 2,
          candidates: [
            {
              id: `candidate-${index + 1}`,
              missionId: mission.id,
              sourceUrl: `https://evidence.example/source-${index + 1}`,
              title: `Evidence ${index + 1}`,
              publication: "Evidence Daily",
              publishedAt: null,
              content,
              contentKind: "source-text",
              sourceType: "independent-reporting",
              discoveryContext: null,
              discoveryExcerpt: content,
              providerScore: 0.8,
              provider: "exa",
            },
          ],
          coveredMissionIds: [mission.id],
          status: "completed",
          error: null,
        };
      }
    },
  };
}

describe("V2 intelligence pipeline", () => {
  const adjudicator: EvidenceAdjudicator = {
    async adjudicate({ candidates, plan }) {
      return candidates.flatMap((candidate) => {
        const mission = plan.missions.find((value) => value.id === candidate.missionId);
        if (!mission?.claimIds[0]) return [];
        return [
          {
            candidateId: candidate.id,
            missionId: mission.id,
            claimId: mission.claimIds[0],
            relationship:
              mission.purpose === "correction-or-qualification" ? "qualifies" : "supports",
            statement: "The source reports the same central claim tested in the article.",
            excerpt: candidate.content,
            confidence: 0.8,
            relevance: 0.85,
            context: null,
          },
        ];
      });
    },
  };

  it("uses one index, bounded planning, a shared ledger, and explicit phases", async () => {
    const events = [];
    for await (const event of analyzeArticle({
      article: article(),
      retriever: retriever(),
      mode: "fast",
      reasoningEffort: "low",
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      createId: () => "plan-fixture",
      adjudicator,
    }))
      events.push(event);

    expect(events[0]?.type).toBe("analysis.started");
    expect(events.some((event) => event.type === "article.indexed")).toBe(true);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "phase.changed",
        "lens.ready",
        "research.progress",
        "ledger.updated",
        "perspective.ready",
        "section.ready",
        "worksCited.ready",
        "analysis.completed",
      ]),
    );
    const completion = events.at(-1);
    expect(completion?.type).toBe("analysis.completed");
    if (completion?.type === "analysis.completed") {
      expect(completion.data.acceptedSources).toBeGreaterThan(0);
      expect(completion.data.status).toBe("complete");
    }
    const lens = events.find((event) => event.type === "lens.ready");
    if (lens?.type === "lens.ready") {
      expect(lens.data.plan.claims.length).toBeLessThanOrEqual(
        resolveAnalysisBudget("fast").maxClaims,
      );
      expect(lens.data.plan.missions.length).toBeLessThanOrEqual(
        resolveAnalysisBudget("fast").maxMissions,
      );
    }
  });

  it("turns cancellation into a terminal cancelled event", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of analyzeArticle({
      article: article(),
      retriever: retriever(),
      adjudicator,
      signal: controller.signal,
    }))
      events.push(event);
    expect(events.at(-1)?.type).toBe("analysis.cancelled");
  });

  it("degrades a failed adjudication without discarding the article-derived report", async () => {
    const events = [];
    let telemetry: { debugRing: string[] } | undefined;
    const emptyErrorAdjudicator: EvidenceAdjudicator = {
      async adjudicate() {
        throw new Error("");
      },
    };
    for await (const event of analyzeArticle({
      article: article(),
      retriever: retriever(),
      adjudicator: emptyErrorAdjudicator,
      mode: "fast",
      reasoningEffort: "low",
      onTelemetry: (value) => {
        telemetry = value;
      },
    }))
      events.push(event);

    expect(events.at(-1)?.type).toBe("analysis.completed");
    const completion = events.at(-1);
    if (completion?.type === "analysis.completed") {
      expect(completion.data.status).toBe("partial");
      expect(completion.data.failedSections).not.toContain("compass");
      expect(completion.data.failedSections).not.toContain("bias");
    }
    expect(telemetry?.debugRing.some((entry) => entry.includes("adjudication.degraded"))).toBe(
      true,
    );
  });

  it("retains article-led spectrum and bias when contextual retrieval fails", async () => {
    const failedRetriever = {
      async *retrieve(plan: RetrievalPlan): AsyncIterable<EvidenceBatch> {
        for (const mission of plan.missions) {
          yield {
            missionId: mission.id,
            provider: "free" as const,
            candidates: [],
            coveredMissionIds: [mission.id],
            status: "failed" as const,
            error: "free discovery unavailable",
            searched: true,
            cacheHit: false,
            durationMs: 1,
          };
        }
      },
    };
    const events = [];
    for await (const event of analyzeArticle({
      article: article(),
      retriever: failedRetriever,
      mode: "balanced",
      reasoningEffort: "medium",
    }))
      events.push(event);

    const perspective = events.find((event) => event.type === "perspective.ready");
    expect(perspective?.type).toBe("perspective.ready");
    if (perspective?.type === "perspective.ready") {
      expect(perspective.data.compass?.score).not.toBeNull();
      expect(perspective.data.compass?.evidence.length).toBeGreaterThan(0);
    }
    const failedSections = events
      .filter((event) => event.type === "section.failed")
      .map((event) => (event.type === "section.failed" ? event.data.section : null));
    expect(failedSections).not.toContain("compass");
    expect(failedSections).not.toContain("bias");
    const completion = events.find((event) => event.type === "analysis.completed");
    if (completion?.type === "analysis.completed") {
      expect(completion.data.failedSections).not.toContain("compass");
      expect(completion.data.failedSections).not.toContain("bias");
    }
  });

  it("retries only requested lanes from the existing artifacts", async () => {
    let artifacts: AnalysisArtifacts | undefined;
    const emptyRetriever = {
      async *retrieve(plan: RetrievalPlan): AsyncIterable<EvidenceBatch> {
        for (const mission of plan.missions) {
          yield {
            missionId: mission.id,
            provider: "exa" as const,
            candidates: [],
            coveredMissionIds: [mission.id],
            status: "failed",
            error: "provider unavailable",
            searched: true,
            cacheHit: false,
            durationMs: 1,
          };
        }
      },
    };
    const firstRun = [];
    for await (const event of analyzeArticle({
      article: article(),
      retriever: emptyRetriever,
      mode: "fast",
      reasoningEffort: "low",
      onArtifacts: (value) => {
        artifacts = value;
      },
    }))
      firstRun.push(event);

    expect(artifacts).toBeDefined();
    expect(firstRun.at(-1)?.type).toBe("analysis.completed");
    if (!artifacts) return;
    const retryEvents = [];
    for await (const event of retryArticleSections({
      artifacts,
      retriever: retriever(),
      sections: ["supporting"],
    }))
      retryEvents.push(event);

    expect(retryEvents.some((event) => event.type === "article.indexed")).toBe(false);
    expect(retryEvents.some((event) => event.type === "lens.ready")).toBe(false);
    expect(retryEvents.some((event) => event.type === "research.progress")).toBe(true);
    expect(retryEvents.some((event) => event.type === "section.ready")).toBe(true);

    let emptyArtifacts: AnalysisArtifacts | undefined;
    const honestlyEmptyRetriever = {
      async *retrieve(plan: RetrievalPlan): AsyncIterable<EvidenceBatch> {
        for (const mission of plan.missions) {
          yield {
            missionId: mission.id,
            provider: "exa" as const,
            candidates: [],
            coveredMissionIds: [mission.id],
            status: "completed" as const,
            error: null,
            searched: true,
            cacheHit: false,
            durationMs: 1,
          };
        }
      },
    };
    for await (const _event of analyzeArticle({
      article: article(),
      retriever: honestlyEmptyRetriever,
      mode: "fast",
      reasoningEffort: "low",
      onArtifacts: (value) => {
        emptyArtifacts = value;
      },
    })) {
      // Drain the complete empty run before checking targeted retry behavior.
    }
    expect(emptyArtifacts).toBeDefined();
    if (!emptyArtifacts) return;
    const emptyRetryEvents = [];
    for await (const event of retryArticleSections({
      artifacts: emptyArtifacts,
      retriever: retriever(),
      sections: ["contradicting"],
    }))
      emptyRetryEvents.push(event);
    expect(emptyRetryEvents.some((event) => event.type === "research.progress")).toBe(false);
  });
});
