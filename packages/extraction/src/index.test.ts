// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { extractArticleDocument } from "./index";

describe("extractArticleDocument", () => {
  it("extracts ordered article content, metadata, and original links", () => {
    document.head.innerHTML = `
      <title>Fallback title</title>
      <meta property="og:title" content="A policy changes the city" />
      <meta property="og:site_name" content="Example News" />
      <meta name="author" content="Austin Reporter" />
      <meta property="article:published_time" content="2026-07-28T12:00:00Z" />
      <link rel="canonical" href="https://example.com/news/policy" />
    `;
    document.documentElement.lang = "en";
    document.body.innerHTML = `
      <nav><p>This navigation text is deliberately long and should never be extracted.</p></nav>
      <article>
        <h1>A policy changes the city</h1>
        <nav><a href="https://example.com/follow">See all topics</a></nav>
        <p>The city council approved a public housing investment intended to reduce unequal access to housing.</p>
        <blockquote cite="City Council">Local participation will guide how the program is carried out in each neighborhood.</blockquote>
        <p>Officials linked the decision to <a href="https://example.gov/record">the public record</a> released Tuesday.</p>
      </article>
    `;

    const article = extractArticleDocument(document, "https://example.com/original");

    expect(article.title).toBe("A policy changes the city");
    expect(article.publication).toBe("Example News");
    expect(article.author).toBe("Austin Reporter");
    expect(article.paragraphs.map((paragraph) => paragraph.kind)).toEqual([
      "paragraph",
      "quote",
      "paragraph",
    ]);
    expect(article.links).toHaveLength(1);
    expect(article.links[0]?.paragraphId).toBe("paragraph-3");
    expect(article.fingerprint).toMatch(/^article-/);
  });

  it("recognizes opinion content from the canonical path", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="A better approach" />
      <link rel="canonical" href="https://example.com/opinion/a-better-approach" />
    `;
    document.body.innerHTML = `
      <main>
        <p>In my view, the market should remain free while personal decisions stay with individuals and communities.</p>
      </main>
    `;

    const article = extractArticleDocument(document, "https://example.com");
    expect(article.contentType).toBe("opinion");
  });

  it("prefers a visible journalist name over a social-profile author meta value", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="US walks out of UN meeting" />
      <meta property="og:site_name" content="BBC News" />
      <meta property="article:author" content="https://www.facebook.com/bbcnews" />
      <link rel="canonical" href="https://www.bbc.com/news/articles/example" />
    `;
    document.body.innerHTML = `
      <article>
        <h1>US walks out of UN meeting</h1>
        <div data-testid="byline-name">By Olivia Ireland</div>
        <p>The US delegation walked out of a United Nations meeting while France's ambassador was speaking.</p>
      </article>
    `;

    const article = extractArticleDocument(document, "https://www.bbc.com/news/articles/example");

    expect(article.author).toBe("Olivia Ireland");
    expect(article.extraction.extractorVersion).toBe("dom-v3");
  });

  it("removes repeated byline prefixes and a duplicated publication suffix", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="Biden classified documents report" />
      <meta property="og:site_name" content="Fox News" />
      <link rel="canonical" href="https://www.foxnews.com/politics/example" />
    `;
    document.body.innerHTML = `
      <article>
        <h1>Biden classified documents report</h1>
        <div data-testid="byline-name">By By Ashley J. DiMella Fox News</div>
        <p>The report examines the release of recordings from an interview about classified documents.</p>
      </article>
    `;

    const article = extractArticleDocument(document, "https://www.foxnews.com/politics/example");

    expect(article.author).toBe("Ashley J. DiMella");
  });

  it("uses structured article authors when visible byline markup is unavailable", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="A documented investigation" />
      <meta name="author" content="https://social.example/newsroom" />
      <script type="application/ld+json">
        {
          "@type": "NewsArticle",
          "author": [{"@type": "Person", "name": "Riley Reporter"}]
        }
      </script>
    `;
    document.body.innerHTML = `
      <article>
        <p>This investigation examines a public record and explains why the underlying decision matters.</p>
      </article>
    `;

    const article = extractArticleDocument(document, "https://example.com/investigation");

    expect(article.author).toBe("Riley Reporter");
  });
});
