import { describe, expect, it } from "vitest";
import { AnalysisEventSchema, type AnalyzeRequest } from "@perspectica/contracts";
import { POST } from "./route";

const requestBody: AnalyzeRequest = {
  article: {
    fingerprint: "fixture-1",
    canonicalUrl: "https://example.com/article",
    title: "A city tests public housing changes",
    author: "Morgan Example",
    publication: "Example News",
    publishedAt: "2026-07-28T12:00:00.000Z",
    language: "en",
    contentType: "news",
    paragraphs: [
      {
        id: "p-1",
        index: 0,
        kind: "paragraph",
        text: "Officials announced a sweeping public housing proposal with equal access for residents.",
        speaker: null,
      },
      {
        id: "p-2",
        index: 1,
        kind: "paragraph",
        text: "The plan would add a community vote and local participation before final approval.",
        speaker: null,
      },
    ],
    links: [
      {
        id: "link-1",
        label: "City proposal",
        url: "https://example.gov/proposal",
        paragraphId: "p-1",
      },
    ],
    extraction: {
      extractorVersion: "test-v1",
      extractedAt: "2026-07-28T12:01:00.000Z",
      wordCount: 25,
    },
  },
  client: { extensionVersion: "test-v1" },
};

describe("POST /api/analyze", () => {
  it("streams a validated analysis from start to completion", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/analyze", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => AnalysisEventSchema.parse(JSON.parse(line)));

    expect(events.at(0)?.type).toBe("analysis.started");
    expect(events.some((event) => event.type === "compass.ready")).toBe(true);
    expect(events.some((event) => event.type === "bias.ready")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "analysis.completed",
      data: { status: "complete", failedSections: [] },
    });
  });

  it("rejects malformed article input", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/analyze", {
        method: "POST",
        body: JSON.stringify({ article: {} }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(422);
  });

  it("rejects an oversized body even without a content-length header", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/analyze", {
        method: "POST",
        body: JSON.stringify({ text: "x".repeat(2_000_001) }),
      }),
    );

    expect(response.status).toBe(413);
  });
});
