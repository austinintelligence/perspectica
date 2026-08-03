import { describe, expect, it, vi } from "vitest";
import type { RetrievalPlan } from "@perspectica/contracts/evidence";
import { FreeEvidenceRetriever, isSafePublisherUrl } from "./free-evidence";

const plan: RetrievalPlan = {
  missions: [
    {
      id: "mission-free",
      claimIds: ["claim-1"],
      purpose: "independent-verification",
      queryVariants: ["example public report"],
      priority: 1,
      estimatedCost: 1,
      freshness: "recent",
      preferredSourceTypes: ["independent-reporting"],
      includeDomains: [],
      excludeDomains: [],
      canServeSections: ["supporting"],
    },
  ],
  maxSources: 2,
  maxConcurrency: 1,
  deadlineAt: Date.now() + 20_000,
};

describe("free V2 evidence retrieval", () => {
  it("allows only public HTTPS publisher URLs", () => {
    expect(isSafePublisherUrl("https://example.com/report")).toBe(true);
    expect(isSafePublisherUrl("http://example.com/report")).toBe(false);
    expect(isSafePublisherUrl("https://127.0.0.1/report")).toBe(false);
    expect(isSafePublisherUrl("https://[::1]/report")).toBe(false);
    expect(isSafePublisherUrl("https://user:secret@example.com/report")).toBe(false);
  });

  it("turns discovery into source text only after a public page read", async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("gdeltproject")) {
        return new Response(
          JSON.stringify({
            articles: [{ url: "https://news.example/report?utm_source=test", title: "Report" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("duckduckgo")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        "<article><p>This is sufficiently long public source text for exact downstream excerpt validation.</p></article>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    const retriever = new FreeEvidenceRetriever(fetchImplementation as typeof fetch);
    const batches = [];
    for await (const batch of retriever.retrieve(plan, new AbortController().signal))
      batches.push(batch);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.candidates[0]).toMatchObject({
      provider: "free",
      sourceUrl: "https://news.example/report",
      contentKind: "source-text",
    });
    expect(batches[0]?.candidates[0]?.discoveryExcerpt).toBeTruthy();
    expect(batches[0]?.candidates[0]).not.toHaveProperty("relationship");
  });

  it("keeps discovery-only summaries non-quoteable", async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("gdeltproject")) {
        return new Response(
          JSON.stringify({ articles: [{ url: "https://news.example/report", title: "Report" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("duckduckgo")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not html", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const retriever = new FreeEvidenceRetriever(fetchImplementation as typeof fetch);
    const batches = [];
    for await (const batch of retriever.retrieve(plan, new AbortController().signal))
      batches.push(batch);

    expect(batches[0]?.candidates[0]).toMatchObject({
      contentKind: "search-summary",
      discoveryExcerpt: null,
    });
  });
});
