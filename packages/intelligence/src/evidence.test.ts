import type { EvidenceCard } from "@perspectica/contracts/evidence";
import { describe, expect, it } from "vitest";
import { validateEvidenceCard } from "./evidence/validation";

function card(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    missionId: "mission-1",
    claimId: "claim-1",
    sourceUrl: "https://evidence.example/story",
    title: "Evidence",
    publication: "Evidence Daily",
    publishedAt: null,
    statement: "The record confirms the claim.",
    excerpt: "The record confirms the claim.",
    content: "The record confirms the claim. Additional context is available.",
    contentKind: "source-text" as const,
    relationship: "supports" as const,
    sourceType: "independent-reporting" as const,
    confidence: 0.8,
    provider: "exa" as const,
    ...overrides,
  };
}

describe("evidence boundary validation", () => {
  it("requires exact source-text excerpts", () => {
    expect(validateEvidenceCard(card(), "https://example.com/article")).toMatchObject({
      accepted: true,
      excerptMatches: true,
    });
    expect(
      validateEvidenceCard(
        card({ excerpt: "A quote that is not present." }),
        "https://example.com/article",
      ),
    ).toMatchObject({ accepted: false, excerptMatches: false });
  });

  it("never treats search summaries as quoteable or the article itself as independent evidence", () => {
    expect(
      validateEvidenceCard(
        card({
          contentKind: "search-summary",
          excerpt: null,
          content: "A URL-attributed search note.",
        }),
        "https://example.com/article",
      ),
    ).toMatchObject({ accepted: true, excerptMatches: false });
    expect(
      validateEvidenceCard(
        card({ contentKind: "search-summary", excerpt: "not allowed" }),
        "https://example.com/article",
      ),
    ).toMatchObject({ accepted: false });
    expect(
      validateEvidenceCard(
        card({ sourceUrl: "https://example.com/article" }),
        "https://example.com/article",
      ),
    ).toMatchObject({ accepted: false, provenance: "article-link" });
  });
});
