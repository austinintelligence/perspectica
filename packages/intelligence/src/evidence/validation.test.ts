import type { ArticleIndex } from "@perspectica/contracts/article";
import type { EvidenceAdjudication, EvidenceCandidate } from "@perspectica/contracts/evidence";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import { describe, expect, it } from "vitest";
import { resolveAnalysisBudget } from "../budgets";
import { EvidenceLedger } from "./source-ledger";
import { validateEvidenceAdjudication } from "./validation";

function article(): ArticleIndex {
  return {
    version: "index-v2",
    fingerprint: "article-fingerprint",
    meta: {
      title: "River County approves 12 projects",
      author: "Alex Reporter",
      publication: "Example News",
      publishedAt: null,
      canonicalUrl: "https://example.com/article",
      contentType: "news",
      language: "en",
    },
    outline: [],
    paragraphs: {
      p1: {
        id: "p1",
        index: 0,
        kind: "paragraph",
        text: "River County approved 12 projects in 2024.",
        preview: "River County approved 12 projects in 2024.",
        speaker: null,
        sentenceIds: ["s1"],
        headingPath: [],
        linkIds: [],
        position: 0,
        tokenCount: 8,
      },
    },
    paragraphOrder: ["p1"],
    sentences: {
      s1: {
        id: "s1",
        paragraphId: "p1",
        index: 0,
        start: 0,
        end: 44,
        text: "River County approved 12 projects in 2024.",
        speaker: null,
        attributionVerb: null,
        isQuoted: false,
      },
    },
    entities: [
      {
        text: "River County",
        normalized: "river county",
        kind: "place",
        paragraphId: "p1",
        sentenceId: "s1",
      },
    ],
    quantities: [
      {
        text: "12",
        normalized: "12",
        kind: "number",
        paragraphId: "p1",
        sentenceId: "s1",
      },
    ],
    dates: [
      {
        text: "2024",
        normalized: "2024",
        paragraphId: "p1",
        sentenceId: "s1",
      },
    ],
    links: [],
    claimSeeds: [],
    extraction: {
      extractorVersion: "test",
      indexedAt: "2026-08-02T12:00:00.000Z",
      wordCount: 8,
      contentChars: 45,
      paragraphCount: 1,
      sentenceCount: 1,
      linkCount: 0,
      contentTruncated: false,
      articleStatus: "article",
    },
  };
}

function plan(): AnalysisPlan {
  return {
    id: "plan-1",
    overview: "One claim.",
    claims: [
      {
        id: "claim-1",
        text: "River County approved 12 projects in 2024.",
        paragraphIds: ["p1"],
        sentenceIds: ["s1"],
        importance: 0.9,
        uncertainty: 0.6,
        researchValue: 0.9,
        queryHints: ["River County 12 projects 2024"],
      },
    ],
    articleSignals: { compass: [], bias: [] },
    missions: [
      {
        id: "mission-verify",
        claimIds: ["claim-1"],
        purpose: "independent-verification",
        queryVariants: ["River County 12 projects 2024"],
        priority: 0.9,
        estimatedCost: 1,
        freshness: "recent",
        preferredSourceTypes: ["independent-reporting"],
        includeDomains: [],
        excludeDomains: [],
        canServeSections: ["supporting", "contradicting"],
      },
    ],
    applicability: {
      compass: { applicable: false, confidence: 0.8, reason: "Not needed." },
      bias: { applicable: false, confidence: 0.8, reason: "Not needed." },
      "journalist-context": { applicable: false, confidence: 0.8, reason: "Not needed." },
      supporting: { applicable: true, confidence: 0.9, reason: "Claim exists." },
      contradicting: { applicable: true, confidence: 0.7, reason: "Claim is uncertain." },
      "additional-context": { applicable: false, confidence: 0.8, reason: "Not needed." },
      "works-cited": { applicable: true, confidence: 1, reason: "Article links." },
    },
    unresolvedQuestions: [],
    requestedParagraphIds: [],
    contextCharacters: 0,
  };
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    id: "candidate-1",
    missionId: "mission-verify",
    sourceUrl: "https://evidence.example/record",
    title: "Independent record",
    publication: "Evidence Daily",
    publishedAt: null,
    sourceType: "independent-reporting",
    contentKind: "source-text",
    content: "The record says River County approved 12 projects in 2024.",
    discoveryContext: null,
    discoveryExcerpt: "The record says River County approved 12 projects in 2024.",
    providerScore: 0.9,
    provider: "exa",
    ...overrides,
  };
}

function decision(overrides: Partial<EvidenceAdjudication> = {}): EvidenceAdjudication {
  return {
    candidateId: "candidate-1",
    missionId: "mission-verify",
    claimId: "claim-1",
    relationship: "supports",
    statement: "The record reports the same approval and quantity described by the article.",
    excerpt: "River County approved 12 projects in 2024.",
    confidence: 0.9,
    relevance: 0.85,
    context: null,
    ...overrides,
  };
}

describe("semantic evidence boundary", () => {
  it("keeps provider candidates out of the ledger until an adjudication is validated", () => {
    const articleIndex = article();
    const analysisPlan = plan();
    const ledger = new EvidenceLedger(
      articleIndex,
      analysisPlan,
      resolveAnalysisBudget("fast", "low"),
    );

    ledger.accept({
      missionId: "mission-verify",
      provider: "exa",
      candidates: [candidate()],
      coveredMissionIds: ["mission-verify"],
      status: "completed",
      error: null,
      searched: true,
      cacheHit: false,
      durationMs: 10,
    });
    expect(ledger.getSources()).toHaveLength(0);
    expect(ledger.getAssertions()).toHaveLength(0);

    const accepted = ledger.acceptAdjudications([decision()]);
    expect(accepted.acceptedAssertions).toBe(1);
    expect(ledger.getAssertions()[0]).toMatchObject({
      relationship: "supports",
      claimId: "claim-1",
      validation: { claimRelevant: true, relationshipChecked: true },
    });
  });

  it("rejects search summaries from becoming support or contradiction claims", () => {
    const checked = validateEvidenceAdjudication(
      decision({
        relationship: "contradicts",
        excerpt: null,
      }),
      candidate({
        contentKind: "search-summary",
        content: "A search summary mentions River County and 12 projects in 2024.",
        discoveryExcerpt: null,
      }),
      article(),
      plan(),
    );
    expect(checked).toMatchObject({
      accepted: false,
      claimRelevant: false,
      relationshipChecked: false,
    });
    expect(checked.reason).toContain("search summary");
  });

  it("rejects cross-mission and ungrounded claim mappings", () => {
    const articleIndex = article();
    const analysisPlan = plan();
    expect(
      validateEvidenceAdjudication(
        decision({ missionId: "mission-unknown" }),
        candidate(),
        articleIndex,
        analysisPlan,
      ).accepted,
    ).toBe(false);
    expect(
      validateEvidenceAdjudication(
        decision({ excerpt: "A different event happened elsewhere." }),
        candidate(),
        articleIndex,
        analysisPlan,
      ).accepted,
    ).toBe(false);
  });

  it("does not let ordinary claim missions manufacture political-context signals", () => {
    const checked = validateEvidenceAdjudication(
      decision({
        relationship: "adds-context",
        claimId: null,
        context: {
          sourceKind: "topic-context",
          subject: "River County",
          score: 1,
          direction: "right",
          strength: 0.6,
          relevance: 0.8,
          explanation: "The source frames the topic in a right-leaning direction.",
        },
      }),
      candidate(),
      article(),
      plan(),
    );
    expect(checked.accepted).toBe(false);
    expect(checked.reason).toContain("context missions");
  });
});
