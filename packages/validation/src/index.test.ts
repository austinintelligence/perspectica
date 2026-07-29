import type { ArticleDocument, BiasFinding, CompassEvidence } from "@perspectica/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSourceList,
  excerptMatchesParagraph,
  validateBiasFindings,
  validateCompassEvidence,
} from "./index";

const article: ArticleDocument = {
  fingerprint: "fixture",
  canonicalUrl: "https://example.com/article",
  title: "Fixture article",
  author: "Reporter",
  publication: "Example News",
  publishedAt: "2026-07-28T12:00:00.000Z",
  language: "en",
  contentType: "news",
  paragraphs: [
    {
      id: "p-1",
      index: 0,
      kind: "paragraph",
      text: "Officials called the sweeping proposal an urgently needed protection for every family.",
      speaker: null,
    },
  ],
  links: [
    {
      id: "link-1",
      label: "Public record",
      url: "https://example.gov/record",
      paragraphId: "p-1",
    },
    {
      id: "link-2",
      label: "Duplicate record",
      url: "https://example.gov/record",
      paragraphId: "p-1",
    },
  ],
  extraction: {
    extractorVersion: "test",
    extractedAt: "2026-07-28T12:00:00.000Z",
    wordCount: 12,
  },
};

describe("excerpt validation", () => {
  it("normalizes smart punctuation and whitespace", () => {
    expect(
      excerptMatchesParagraph(
        "Officials called the sweeping proposal an urgently needed protection",
        article.paragraphs[0]!.text,
      ),
    ).toBe(true);
  });

  it("drops compass excerpts that do not exist in the referenced paragraph", () => {
    const candidate: CompassEvidence = {
      id: "e-1",
      paragraphId: "p-1",
      excerpt: "A sentence that was never present in the article.",
      speaker: null,
      endorsedByArticle: true,
      score: -1,
      direction: "left",
      strength: 0.7,
      relevance: 0.8,
      explanation: "Test",
    };

    expect(validateCompassEvidence(article, [candidate])).toEqual([]);
  });

  it("accepts exact grounded evidence on the one-dimensional spectrum", () => {
    const candidate: CompassEvidence = {
      id: "e-valid",
      paragraphId: "p-1",
      excerpt: article.paragraphs[0]!.text,
      speaker: null,
      endorsedByArticle: true,
      score: -0.9,
      direction: "left",
      strength: 0.8,
      relevance: 0.8,
      explanation: "The article endorses a center-left policy frame.",
    };

    expect(validateCompassEvidence(article, [candidate])).toEqual([candidate]);
  });

  it("rejects a direction that conflicts with its numeric score", () => {
    const candidate: CompassEvidence = {
      id: "e-direction",
      paragraphId: "p-1",
      excerpt: article.paragraphs[0]!.text,
      speaker: null,
      endorsedByArticle: true,
      score: 1.2,
      direction: "left",
      strength: 0.8,
      relevance: 0.8,
      explanation: "The score and direction conflict.",
    };

    expect(validateCompassEvidence(article, [candidate])).toEqual([]);
  });

  it("deduplicates identical spectrum evidence", () => {
    const candidate: CompassEvidence = {
      id: "e-one",
      paragraphId: "p-1",
      excerpt: article.paragraphs[0]!.text,
      speaker: null,
      endorsedByArticle: true,
      score: 0,
      direction: "center",
      strength: 0.8,
      relevance: 0.8,
      explanation: "The passage uses a balanced frame.",
    };

    expect(validateCompassEvidence(article, [candidate, { ...candidate, id: "e-two" }])).toEqual([
      candidate,
    ]);
  });
});

describe("section validation", () => {
  it("ranks valid bias findings and avoids repeating one excerpt as multiple techniques", () => {
    const base: BiasFinding = {
      id: "bias-1",
      technique: "emotional-sensationalism",
      displayName: "Emotional language",
      paragraphId: "p-1",
      excerpt: article.paragraphs[0]!.text,
      explanation: "The sentence uses urgency and broad protection language.",
      confidence: 0.8,
      relevance: 0.8,
      prominence: 0.8,
    };

    const result = validateBiasFindings(article, [
      base,
      { ...base, id: "bias-2", technique: "word-choice" },
    ]);

    expect(result.status).toBe("ready");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.displayName).toBe("Emotional or sensational framing");
  });

  it("does not attribute a newsmaker's quoted rhetoric to the article", () => {
    const quotedArticle: ArticleDocument = {
      ...article,
      paragraphs: [
        {
          id: "p-quote",
          index: 0,
          kind: "paragraph",
          text: `The ambassador accused France of "cozying up to the world's worst oppressors", without elaborating.`,
          speaker: null,
        },
      ],
    };
    const result = validateBiasFindings(quotedArticle, [
      {
        id: "bias-quote",
        technique: "word-choice",
        displayName: "Demonizing characterization",
        paragraphId: "p-quote",
        excerpt: `"cozying up to the world's worst oppressors"`,
        explanation: "The phrase uses emotionally charged characterization.",
        confidence: 0.9,
        relevance: 0.9,
        prominence: 0.8,
      },
    ]);

    expect(result).toMatchObject({
      status: "empty",
      findings: [],
    });
  });

  it("uses canonical labels and keeps only the strongest finding per technique", () => {
    const result = validateBiasFindings(article, [
      {
        id: "bias-weaker",
        technique: "word-choice",
        displayName: "Pejorative framing",
        paragraphId: "p-1",
        excerpt: "sweeping proposal",
        explanation: "The adjective broadens the proposal's perceived scope.",
        confidence: 0.5,
        relevance: 0.7,
        prominence: 0.8,
      },
      {
        id: "bias-stronger",
        technique: "word-choice",
        displayName: "Loaded language",
        paragraphId: "p-1",
        excerpt: "urgently needed protection for every family",
        explanation: "The language adds urgency and universal stakes.",
        confidence: 0.9,
        relevance: 0.9,
        prominence: 0.9,
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      id: "bias-stronger",
      displayName: "Loaded word choice",
    });
  });

  it("does not call missing broader context proof of cherry-picking", () => {
    const recordingsArticle: ArticleDocument = {
      ...article,
      paragraphs: [
        {
          id: "p-recordings",
          index: 0,
          kind: "paragraph",
          text: "The recordings show instances where Biden takes long pauses, forgets names, and cannot recall specific days.",
          speaker: null,
        },
      ],
    };

    const result = validateBiasFindings(recordingsArticle, [
      {
        id: "bias-selection",
        technique: "cherry-picking",
        displayName: "Cherry-picking",
        paragraphId: "p-recordings",
        excerpt: recordingsArticle.paragraphs[0]!.text,
        explanation:
          "The article highlights impairment-related moments without supplying broader context about the recordings.",
        confidence: 0.8,
        relevance: 0.8,
        prominence: 0.8,
      },
    ]);

    expect(result).toMatchObject({ status: "empty", findings: [] });
  });

  it("deduplicates original article sources", () => {
    expect(buildSourceList(article).sources).toHaveLength(1);
  });

  it("turns noisy article links into a compact works-cited list", () => {
    const noisyArticle: ArticleDocument = {
      ...article,
      canonicalUrl: "https://www.cnn.com/2026/02/24/politics/fact-check",
      links: [
        {
          id: "navigation",
          label: "See all topics",
          url: "https://www.cnn.com/follow",
          paragraphId: null,
        },
        {
          id: "topic",
          label: "Donald Trump",
          url: "https://www.cnn.com/politics/president-donald-trump-47",
          paragraphId: null,
        },
        {
          id: "white-house",
          label: "own website",
          url: "https://www.whitehouse.gov/investments/?utm_source=cnn",
          paragraphId: "p-1",
        },
        {
          id: "aaa",
          label: "according to AAA",
          url: "https://gasprices.aaa.com/state-gas-price-averages/",
          paragraphId: "p-1",
        },
        {
          id: "bls-one",
          label: "was 3.0%",
          url: "https://www.bls.gov/news.release/cpi.t02.htm",
          paragraphId: "p-1",
        },
        {
          id: "bls-two",
          label: "unemployment rate",
          url: "https://data.bls.gov/timeseries/UNRATE",
          paragraphId: "p-1",
        },
        {
          id: "bls-three",
          label: "employment-population ratio",
          url: "https://data.bls.gov/timeseries/EMRATIO",
          paragraphId: "p-1",
        },
        {
          id: "social",
          label: "posted",
          url: "https://x.com/example/status/123",
          paragraphId: "p-1",
        },
        ...Array.from({ length: 14 }, (_, index) => ({
          id: `other-${index}`,
          label: `Independent report ${index + 1}`,
          url: `https://source-${index + 1}.org/report-${index + 1}`,
          paragraphId: "p-1",
        })),
      ],
    };

    const result = buildSourceList(noisyArticle);

    expect(result.status).toBe("ready");
    expect(result.sources).toHaveLength(8);
    expect(result.sources.some((source) => source.label === "See all topics")).toBe(false);
    expect(result.sources.some((source) => source.url.includes("x.com"))).toBe(false);
    expect(result.sources.filter((source) => source.url.includes("bls.gov"))).toHaveLength(2);
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        label: "The White House — Investments",
        url: "https://www.whitehouse.gov/investments",
      }),
    );
    expect(result.sources.map((source) => source.label)).toEqual(
      [...result.sources.map((source) => source.label)].sort((left, right) =>
        left.localeCompare(right, "en-US"),
      ),
    );
  });

  it("keeps a cited public statement while removing newsletter signup links", () => {
    const bbcArticle: ArticleDocument = {
      ...article,
      canonicalUrl: "https://www.bbc.com/news/articles/example",
      links: [
        {
          id: "x-statement",
          label: "it posted on X, external",
          url: "https://x.com/FranceONUGeneve/status/2081064968586232263",
          paragraphId: "p-1",
        },
        {
          id: "newsletter-uk",
          label: "sign up here",
          url: "https://www.bbc.co.uk/newsletters/zgmn46f",
          paragraphId: "p-1",
        },
        {
          id: "newsletter-outside",
          label: "outside the UK can sign up here",
          url: "https://cloud.email.bbc.com/US_Politics_Unspun_Newsletter_Signup",
          paragraphId: "p-1",
        },
      ],
    };

    const result = buildSourceList(bbcArticle);

    expect(result.sources).toEqual([
      expect.objectContaining({
        label: "X — It posted on X",
        url: "https://x.com/FranceONUGeneve/status/2081064968586232263",
      }),
    ]);
  });

  it("keeps cited Fox reporting while removing same-site category navigation", () => {
    const foxArticle: ArticleDocument = {
      ...article,
      canonicalUrl: "https://www.foxnews.com/politics/current-story",
      publication: "Fox News",
      paragraphs: [
        {
          id: "p-1",
          index: 0,
          kind: "paragraph",
          text: "Fox News previously reported that BIDEN'S HUR INTERVIEW TAPES COULD NOW GO PUBLIC AFTER HIS ATTORNEYS WAVE WHITE FLAG after the court ruling.",
          speaker: null,
        },
      ],
      links: [
        {
          id: "related-report",
          label:
            "BIDEN'S HUR INTERVIEW TAPES COULD NOW GO PUBLIC AFTER HIS ATTORNEYS WAVE WHITE FLAG",
          url: "https://www.foxnews.com/politics/bidens-hur-interview-tapes-could-now-go-public-after-his-attorneys-wave-white-flag",
          paragraphId: "p-1",
        },
        {
          id: "person-category",
          label: "Obama administration",
          url: "https://www.foxnews.com/category/person/barack-obama",
          paragraphId: "p-1",
        },
      ],
    };

    expect(buildSourceList(foxArticle).sources).toEqual([
      expect.objectContaining({
        label:
          "Fox News — Biden's Hur Interview Tapes Could Now Go Public After His Attorneys Wave White Flag",
      }),
    ]);
  });

  it("does not let an earlier rejected duplicate hide a later valid citation", () => {
    const duplicateLinkArticle: ArticleDocument = {
      ...article,
      paragraphs: [
        {
          id: "p-related",
          index: 0,
          kind: "paragraph",
          text: "Related story",
          speaker: null,
        },
        {
          id: "p-citation",
          index: 1,
          kind: "paragraph",
          text: "According to the public record, officials approved the proposal.",
          speaker: null,
        },
      ],
      links: [
        {
          id: "rejected-first",
          label: "Weekly newsletter signup",
          url: "https://example.gov/record",
          paragraphId: "p-related",
        },
        {
          id: "valid-second",
          label: "Public record",
          url: "https://example.gov/record",
          paragraphId: "p-citation",
        },
      ],
    };

    expect(buildSourceList(duplicateLinkArticle).sources).toEqual([
      expect.objectContaining({ id: "valid-second" }),
    ]);
  });

  it("removes same-site related-story modules that are not article citations", () => {
    const relatedStoryArticle: ArticleDocument = {
      ...article,
      canonicalUrl: "https://www.foxnews.com/world/current-story",
      publication: "Fox News",
      paragraphs: [
        {
          id: "p-related",
          index: 0,
          kind: "paragraph",
          text: "Gunfire Shatters Toronto Latin Street Festival, Leaving At Least 2 Dead.",
          speaker: null,
        },
      ],
      links: [
        {
          id: "related-card",
          label: "Gunfire Shatters Toronto Latin Street Festival, Leaving At Least 2 Dead",
          url: "https://www.foxnews.com/world/gunfire-shatters-toronto-latin-street-festival",
          paragraphId: "p-related",
        },
      ],
    };

    expect(buildSourceList(relatedStoryArticle)).toEqual({
      status: "empty",
      sources: [],
    });
  });

  it("removes corporate trust-principles boilerplate from works cited", () => {
    const reutersArticle: ArticleDocument = {
      ...article,
      canonicalUrl: "https://www.reuters.com/world/example-story-2026-07-28/",
      publication: "Reuters",
      paragraphs: [
        {
          id: "p-trust",
          index: 0,
          kind: "paragraph",
          text: "The Thomson Reuters Trust Principles, opens new tab",
          speaker: null,
        },
      ],
      links: [
        {
          id: "trust-principles",
          label: "The Thomson Reuters Trust Principles, opens new tab",
          url: "https://www.thomsonreuters.com/en/about-us/trust-principles.html",
          paragraphId: "p-trust",
        },
      ],
    };

    expect(buildSourceList(reutersArticle)).toEqual({
      status: "empty",
      sources: [],
    });
  });

  it("uses readable publication names and path titles for weak citation labels", () => {
    const citationsArticle: ArticleDocument = {
      ...article,
      canonicalUrl: "https://www.cnn.com/politics/example",
      links: [
        {
          id: "transcript",
          label: "He said",
          url: "https://www.rev.com/transcripts/trump-meets-zelenskiy-on-sidelines-of-nato-summit",
          paragraphId: "p-1",
        },
        {
          id: "car-report",
          label: "Ford tariff refund class action lawsuit",
          url: "https://www.caranddriver.com/news/a71933688/ford-tariff-refund-class-action-lawsuit",
          paragraphId: "p-1",
        },
      ],
    };

    expect(buildSourceList(citationsArticle).sources).toEqual([
      expect.objectContaining({
        label: "Car and Driver — Ford tariff refund class action lawsuit",
      }),
      expect.objectContaining({
        label: "Rev — Trump meets zelenskiy on sidelines of nato summit",
      }),
    ]);
  });
});
