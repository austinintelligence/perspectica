import { ArticleDocumentSchema } from "@perspectica/contracts";
import { describe, expect, it } from "vitest";
import { buildArticleIndex } from "./article-index";

describe("ArticleIndex link classification", () => {
  it("keeps sharing, embedded-audio, and app links out of editorial sources", () => {
    const article = ArticleDocumentSchema.parse({
      fingerprint: "article-links",
      canonicalUrl: "https://www.foxnews.com/story",
      title: "A story",
      author: "Reporter",
      publication: "Fox News",
      publishedAt: null,
      language: "en",
      contentType: "news",
      paragraphs: [
        {
          id: "p1",
          index: 0,
          kind: "paragraph",
          speaker: null,
          text: "The report described the event and cited an outside record.",
        },
      ],
      links: [
        {
          id: "flipboard",
          label: "Flipboard",
          url: "https://share.flipboard.com/bookmarklet/popout?url=https%3A%2F%2Fwww.foxnews.com%2Fstory",
          paragraphId: null,
        },
        {
          id: "beyondwords",
          label: "beyondwords.io",
          url: "https://beyondwords.io/player/example",
          paragraphId: null,
        },
        {
          id: "app",
          label: "CLICK HERE TO DOWNLOAD THE FOX NEWS APP",
          url: "https://foxnews.onelink.me/example",
          paragraphId: null,
        },
        {
          id: "primary",
          label: "Public record",
          url: "https://example.gov/record",
          paragraphId: "p1",
        },
      ],
      extraction: {
        extractorVersion: "test",
        extractedAt: "2026-08-03T00:00:00.000Z",
        wordCount: 10,
        articleStatus: "article",
        contentChars: 62,
        contentTruncated: false,
      },
    });

    const index = buildArticleIndex(article);
    expect(Object.fromEntries(index.links.map((link) => [link.id, link.classification]))).toEqual({
      flipboard: "social",
      beyondwords: "promotional",
      app: "promotional",
      primary: "likely-primary",
    });
  });
});
