import { ArticleDocumentSchema } from "@perspectica/contracts";
import type { EvidenceBatch, RetrievalPlan } from "@perspectica/contracts/evidence";
import { describe, expect, it } from "vitest";
import {
  analyzeArticle,
  resolveAnalysisBudget,
  retryArticleSections,
  type AnalysisArtifacts,
} from "./index";

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
        const content = `Independent record ${index + 1} confirms the bounded claim tested by ${mission.id}.`;
        yield {
          missionId: mission.id,
          provider: "exa",
          searched: true,
          cacheHit: false,
          durationMs: 2,
          cards: [
            {
              missionId: mission.id,
              claimId: mission.claimIds[0] ?? null,
              sourceUrl: `https://evidence.example/source-${index + 1}`,
              title: `Evidence ${index + 1}`,
              publication: "Evidence Daily",
              publishedAt: null,
              statement: content,
              excerpt: content,
              content,
              contentKind: "source-text",
              relationship:
                mission.purpose === "correction-or-qualification" ? "qualifies" : "supports",
              sourceType: "independent-reporting",
              confidence: 0.8,
              provider: "exa",
            },
          ],
        };
      }
    },
  };
}

describe("V2 intelligence pipeline", () => {
  it("uses one index, bounded planning, a shared ledger, and explicit phases", async () => {
    const events = [];
    for await (const event of analyzeArticle({
      article: article(),
      retriever: retriever(),
      mode: "fast",
      reasoningEffort: "low",
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      createId: () => "plan-fixture",
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
      signal: controller.signal,
    }))
      events.push(event);
    expect(events.at(-1)?.type).toBe("analysis.cancelled");
  });

  it("retries only requested lanes from the existing artifacts", async () => {
    let artifacts: AnalysisArtifacts | undefined;
    const emptyRetriever = {
      async *retrieve(plan: RetrievalPlan): AsyncIterable<EvidenceBatch> {
        for (const mission of plan.missions) {
          yield {
            missionId: mission.id,
            provider: "exa" as const,
            cards: [],
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
  });
});
