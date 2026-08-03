import { describe, expect, it, vi } from "vitest";
import type { RetrievalPlan } from "@perspectica/contracts/evidence";
import { FreeEvidenceRetriever, isSafePublisherUrl, readBounded } from "./free-evidence";

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
    expect(isSafePublisherUrl("https://[::ffff:127.0.0.1]/report")).toBe(false);
    expect(isSafePublisherUrl("https://[::ffff:7f00:1]/report")).toBe(false);
    expect(isSafePublisherUrl("https://user:secret@example.com/report")).toBe(false);
  });

  it("stops reading a chunked response once the byte budget is exceeded", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_000));
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBounded(new Response(body, { headers: { "content-type": "text/html" } })),
    ).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
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

  it("validates every redirect before fetching the next URL", async () => {
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
      return new Response(null, {
        status: 302,
        headers: { location: "https://[::ffff:127.0.0.1]/private" },
      });
    });
    const retriever = new FreeEvidenceRetriever(fetchImplementation as typeof fetch);
    const batches = [];
    for await (const batch of retriever.retrieve(plan, new AbortController().signal))
      batches.push(batch);

    expect(batches[0]?.candidates[0]).toMatchObject({
      contentKind: "search-summary",
      discoveryExcerpt: null,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });
});
