import { describe, expect, it } from "vitest";
import {
  ARTICLE_MAX_CONTENT_CHARS,
  ArticleDocumentSchema,
  ExternalSourceSchema,
  RESEARCH_PROFILES,
  ResearchDepthSchema,
  normalizeCanonicalUrl,
} from "./index";
import { EvidenceProviderSchema } from "./evidence";
import { ANALYSIS_LIMITS } from "./limits";

const baseArticle = {
  fingerprint: "fixture",
  canonicalUrl: "https://example.com/story",
  title: "A story",
  author: null,
  publication: null,
  publishedAt: null,
  language: "en",
  contentType: "news" as const,
  paragraphs: [
    {
      id: "p-1",
      index: 0,
      kind: "paragraph" as const,
      text: "A grounded paragraph.",
      speaker: null,
    },
  ],
  links: [],
  extraction: {
    extractorVersion: "test",
    extractedAt: "2026-07-28T12:00:00.000Z",
    wordCount: 3,
  },
};

describe("normalizeCanonicalUrl", () => {
  it("removes tracking parameters, fragments, default ports, and trailing slashes", () => {
    expect(
      normalizeCanonicalUrl(
        "HTTPS://Example.COM:443/news/story/?utm_source=feed&b=2&a=1&FBCLID=abc#comments",
      ),
    ).toBe("https://example.com/news/story?a=1&b=2");
  });

  it("resolves relative links against a base URL", () => {
    expect(normalizeCanonicalUrl("/source/?gclid=123", "https://Example.com/story/")).toBe(
      "https://example.com/source",
    );
  });

  it("returns null for non-web or malformed URLs", () => {
    expect(normalizeCanonicalUrl("mailto:reader@example.com")).toBeNull();
    expect(normalizeCanonicalUrl("not a URL")).toBeNull();
  });

  it("rejects URLs with embedded credentials", () => {
    expect(normalizeCanonicalUrl("https://reader:secret@example.com/news/story")).toBeNull();
    expect(normalizeCanonicalUrl("https://reader@example.com/news/story")).toBeNull();
  });

  it("removes credential-like query parameters before returning a URL", () => {
    expect(
      normalizeCanonicalUrl(
        "https://example.com/news/story?token=secret&state=opaque&x-amz-signature=signed&edition=us",
      ),
    ).toBe("https://example.com/news/story?edition=us");
  });

  it("rejects URLs that exceed the canonical URL budget", () => {
    expect(normalizeCanonicalUrl(`https://example.com/news?value=${"x".repeat(5_000)}`)).toBeNull();
  });
});

describe("ArticleDocumentSchema", () => {
  it("rejects documents whose aggregate paragraph payload exceeds the budget", () => {
    const oversized = {
      ...baseArticle,
      paragraphs: [
        {
          id: "p-1",
          index: 0,
          kind: "paragraph" as const,
          text: "x".repeat(20_000),
          speaker: null,
        },
      ].concat(
        Array.from({ length: Math.ceil(ARTICLE_MAX_CONTENT_CHARS / 20_000) }, (_, index) => ({
          id: `p-${index + 2}`,
          index: index + 1,
          kind: "paragraph" as const,
          text: "x".repeat(20_000),
          speaker: null,
        })),
      ),
    };

    expect(ArticleDocumentSchema.safeParse(oversized).success).toBe(false);
  });

  it("accepts a normal long-form payload within the budget", () => {
    const longForm = {
      ...baseArticle,
      paragraphs: Array.from({ length: 100 }, (_, index) => ({
        id: `p-${index + 1}`,
        index,
        kind: "paragraph" as const,
        text: "A normal long-form paragraph with enough detail to analyze. ".repeat(20),
        speaker: null,
      })),
    };

    expect(ArticleDocumentSchema.safeParse(longForm).success).toBe(true);
  });
});

describe("ExternalSourceSchema", () => {
  const source = {
    id: "source-1",
    claimId: "claim-1",
    title: "Independent report",
    publication: "Example News",
    publishedAt: null,
    relationship: "supports" as const,
    relationshipExplanation: "The report supports the article's central factual claim.",
    url: "https://example.com/report",
    sourceType: "independent-reporting" as const,
    publicationContext: null,
  };

  it("keeps older exact-excerpt citations wire-compatible", () => {
    expect(
      ExternalSourceSchema.safeParse({
        ...source,
        excerpt: "This sentence was retrieved from the source page.",
      }).success,
    ).toBe(true);
  });

  it("requires search summaries to omit quoteable excerpt text", () => {
    expect(
      ExternalSourceSchema.safeParse({
        ...source,
        citationKind: "search-summary",
        excerpt: null,
      }).success,
    ).toBe(true);
    expect(
      ExternalSourceSchema.safeParse({
        ...source,
        citationKind: "search-summary",
        excerpt: "Model-generated text must not look like a source quotation.",
      }).success,
    ).toBe(false);
  });
});

describe("V2 research depth and providers", () => {
  it("exposes the four bounded depth profiles", () => {
    expect(ResearchDepthSchema.options).toEqual(["quick", "balanced", "deep", "verified"]);
    expect(RESEARCH_PROFILES.quick.maxModelSteps).toBe(2);
    expect(RESEARCH_PROFILES.verified.maxOutputTokens).toBe(4_000);
    expect(RESEARCH_PROFILES.verified.specialistTimeoutMs).toBe(600_000);
    expect(
      (["quick", "balanced", "deep", "verified"] as const).map((depth) => [
        ANALYSIS_LIMITS[depth].maxMissions,
        ANALYSIS_LIMITS[depth].maxSources,
        ANALYSIS_LIMITS[depth].maxModelSteps,
        ANALYSIS_LIMITS[depth].totalDeadlineMs,
      ]),
    ).toEqual([
      [1, 2, 2, 90_000],
      [3, 5, 3, 180_000],
      [5, 8, 5, 360_000],
      [8, 12, 6, 600_000],
    ]);
  });

  it("accepts all canonical evidence providers", () => {
    for (const provider of ["free", "chatgpt", "exa"] as const) {
      expect(EvidenceProviderSchema.parse(provider)).toBe(provider);
    }
  });
});
