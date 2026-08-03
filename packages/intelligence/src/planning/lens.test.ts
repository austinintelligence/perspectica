import type { ArticleIndex } from "@perspectica/contracts/article";
import type { ArticleBiasSignal, ArticleCompassSignal } from "@perspectica/contracts/report";
import { describe, expect, it } from "vitest";
import { groundedArticleSignals } from "./lens";

function article(): ArticleIndex {
  return {
    version: "index-v2",
    fingerprint: "article-fingerprint",
    meta: {
      title: "A grounded article",
      author: null,
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
        text: "The proposal is obviously expensive.",
        preview: "The proposal is obviously expensive.",
        speaker: null,
        sentenceIds: ["s1"],
        headingPath: [],
        linkIds: [],
        position: 0,
        tokenCount: 6,
      },
      p2: {
        id: "p2",
        index: 1,
        kind: "quote",
        text: "Maya Chen said the proposal is affordable.",
        preview: "Maya Chen said the proposal is affordable.",
        speaker: "Maya Chen",
        sentenceIds: ["s2"],
        headingPath: [],
        linkIds: [],
        position: 0.5,
        tokenCount: 7,
      },
    },
    paragraphOrder: ["p1", "p2"],
    sentences: {
      s1: {
        id: "s1",
        paragraphId: "p1",
        index: 0,
        start: 0,
        end: 37,
        text: "The proposal is obviously expensive.",
        speaker: null,
        attributionVerb: null,
        isQuoted: false,
      },
      s2: {
        id: "s2",
        paragraphId: "p2",
        index: 0,
        start: 0,
        end: 44,
        text: "Maya Chen said the proposal is affordable.",
        speaker: "Maya Chen",
        attributionVerb: "said",
        isQuoted: true,
      },
    },
    entities: [],
    quantities: [],
    dates: [],
    links: [],
    claimSeeds: [],
    extraction: {
      extractorVersion: "test",
      indexedAt: "2026-08-02T12:00:00.000Z",
      wordCount: 13,
      contentChars: 82,
      paragraphCount: 2,
      sentenceCount: 2,
      linkCount: 0,
      contentTruncated: false,
      articleStatus: "article",
    },
  };
}

describe("article signal grounding", () => {
  it("drops cross-paragraph bias excerpts and repairs compass direction and attribution", () => {
    const compass: ArticleCompassSignal = {
      paragraphIds: ["p1"],
      sentenceIds: ["s2"],
      score: -2,
      direction: "right",
      strength: 0.8,
      explanation: "The signal is left-coded.",
      attributed: true,
    };
    const bias: ArticleBiasSignal = {
      id: "bias-1",
      technique: "word-choice",
      paragraphId: "p1",
      sentenceId: "s2",
      excerpt: "Maya Chen said the proposal is affordable.",
      explanation: "The wording is evaluative.",
      confidence: 0.8,
      attributed: true,
    };

    const grounded = groundedArticleSignals({ compass: [compass], bias: [bias] }, article());

    expect(grounded.compass[0]).toMatchObject({
      paragraphIds: ["p1"],
      sentenceIds: ["s1"],
      direction: "left",
      attributed: false,
    });
    expect(grounded.bias).toEqual([]);
  });

  it("requires an exact article substring for a bias signal", () => {
    const grounded = groundedArticleSignals(
      {
        compass: [],
        bias: [
          {
            id: "bias-2",
            technique: "word-choice",
            paragraphId: "p1",
            sentenceId: "s1",
            excerpt: "not present in the article",
            explanation: "Unsupported.",
            confidence: 0.8,
            attributed: false,
          },
        ],
      },
      article(),
    );
    expect(grounded.bias).toEqual([]);
  });
});
