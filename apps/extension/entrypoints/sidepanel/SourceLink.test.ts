import type { ExternalSource } from "@perspectica/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceLink } from "./App";

const baseSource = {
  id: "source-1",
  claimId: "claim-1",
  title: "Independent report",
  publication: "Example News",
  publishedAt: null,
  relationship: "supports",
  relationshipExplanation: "Independent reporting supports the article's central factual claim.",
  url: "https://example.com/report",
  sourceType: "independent-reporting",
  publicationContext: null,
} as const;

describe("SourceLink", () => {
  it("labels a native search summary and never renders its note as a quotation", () => {
    const source: ExternalSource = {
      ...baseSource,
      citationKind: "search-summary",
      excerpt: null,
    };

    const markup = renderToStaticMarkup(createElement(SourceLink, { source }));

    expect(markup).toContain("Web-search summary");
    expect(markup).toContain('href="https://example.com/report"');
    expect(markup).not.toContain("<blockquote");
  });

  it("continues to render an exact source excerpt as a quotation", () => {
    const source: ExternalSource = {
      ...baseSource,
      citationKind: "source-excerpt",
      excerpt: "This exact sentence came from the retrieved page.",
    };

    const markup = renderToStaticMarkup(createElement(SourceLink, { source }));

    expect(markup).toContain("<blockquote");
    expect(markup).toContain("retrieved");
    expect(markup).toContain("page.”");
    expect(markup).not.toContain("Web-search summary");
  });
});
