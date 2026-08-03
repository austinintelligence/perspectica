import type { ArticleIndex } from "@perspectica/contracts/article";
import { describe, expect, it } from "vitest";
import { projectSourceList } from "./projector";

describe("report source projection", () => {
  it("excludes navigation, social, promotional, and unclassified links", () => {
    const result = projectSourceList({
      links: [
        {
          id: "external",
          label: "External record",
          url: "https://source.example/record",
          paragraphId: "p1",
          classification: "external",
          host: "source.example",
        },
        {
          id: "primary",
          label: "Primary record",
          url: "https://gov.example/record",
          paragraphId: "p1",
          classification: "likely-primary",
          host: "gov.example",
        },
        {
          id: "same",
          label: "Related reporting",
          url: "https://example.com/related",
          paragraphId: "p2",
          classification: "same-publication",
          host: "example.com",
        },
        {
          id: "nav",
          label: "Home",
          url: "https://example.com/",
          paragraphId: null,
          classification: "navigation",
          host: "example.com",
        },
        {
          id: "social",
          label: "Share",
          url: "https://social.example/share",
          paragraphId: null,
          classification: "social",
          host: "social.example",
        },
        {
          id: "promo",
          label: "Subscribe",
          url: "https://example.com/subscribe",
          paragraphId: null,
          classification: "promotional",
          host: "example.com",
        },
        {
          id: "unknown",
          label: "Unclassified",
          url: "https://unknown.example/link",
          paragraphId: null,
          classification: "unknown",
          host: "unknown.example",
        },
      ],
    } as ArticleIndex);

    expect(result.sources.map((source) => source.id)).toEqual(["external", "primary"]);
  });
});
