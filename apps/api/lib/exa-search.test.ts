import { describe, expect, it, vi } from "vitest";
import { ExaSearchProvider } from "./exa-search";

describe("ExaSearchProvider", () => {
  it("requests fast highlighted results and maps them into bounded research evidence", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        results: [
          {
            id: "exa-result-1",
            title: "Official housing record",
            url: "https://example.gov/housing",
            publishedDate: "2026-07-28T12:00:00.000Z",
            score: 0.92,
            highlights: [
              "The program is designed to serve 1,000 residents.",
              "Funding begins next year.",
            ],
          },
        ],
      }),
    );
    const provider = new ExaSearchProvider({
      apiKey: "test-key",
      fetch: fetchMock,
    });

    const results = await provider.search({
      query: "housing program official record",
      topic: "news",
      maxResults: 5,
      excludeDomains: ["example.com"],
      includeDomains: ["example.com"],
    });

    expect(results).toEqual([
      {
        id: "exa-result-1",
        title: "Official housing record",
        url: "https://example.gov/housing",
        content: "The program is designed to serve 1,000 residents.\n\nFunding begins next year.",
        publishedAt: "2026-07-28T12:00:00.000Z",
        score: 0.92,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-api-key": "test-key",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "housing program official record",
      type: "fast",
      numResults: 5,
      excludeDomains: ["example.com"],
      contents: { highlights: true },
      includeDomains: ["example.com"],
    });
  });

  it("fails before making a request when the server credential is missing", async () => {
    const fetchMock = vi.fn();
    const provider = new ExaSearchProvider({
      apiKey: "",
      fetch: fetchMock,
    });

    await expect(
      provider.search({
        query: "test",
        topic: "general",
        maxResults: 3,
        excludeDomains: [],
      }),
    ).rejects.toThrow("EXA_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces identical in-flight searches and caches the result briefly", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          {
            id: "exa-cached",
            title: "Cached source",
            url: "https://example.gov/source",
            highlights: ["A bounded result."],
          },
        ],
      }),
    );
    const provider = new ExaSearchProvider({
      apiKey: "test-key",
      fetch: fetchMock,
      cacheTtlMs: 1_000,
    });
    const request = {
      query: "same query",
      topic: "news" as const,
      maxResults: 3,
      excludeDomains: ["example.com"],
    };

    const [first, second] = await Promise.all([provider.search(request), provider.search(request)]);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledOnce();
    await provider.search(request);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps shared Exa work alive when only one coalesced consumer aborts", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(() => response);
    const provider = new ExaSearchProvider({
      apiKey: "test-key",
      fetch: fetchMock,
    });
    const controller = new AbortController();
    const request = {
      query: "shared query",
      topic: "news" as const,
      maxResults: 2,
      excludeDomains: [],
    };

    const cancelledConsumer = provider.search({ ...request, signal: controller.signal });
    const activeConsumer = provider.search(request);
    controller.abort();
    await expect(cancelledConsumer).rejects.toMatchObject({ name: "AbortError" });

    resolveResponse(
      Response.json({
        results: [
          {
            id: "exa-shared",
            title: "Shared source",
            url: "https://example.gov/shared",
            highlights: ["The active consumer still receives this result."],
          },
        ],
      }),
    );

    await expect(activeConsumer).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("evicts failed and aborted searches so a later request can retry", async () => {
    let call = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("temporary failure"));
      if (call === 2) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        });
      }
      return Promise.resolve(
        Response.json({
          results: [
            {
              id: "exa-retry",
              title: "Retry source",
              url: "https://example.gov/retry",
              highlights: ["A retry succeeded."],
            },
          ],
        }),
      );
    });
    const provider = new ExaSearchProvider({
      apiKey: "test-key",
      fetch: fetchMock,
    });
    const request = {
      query: "retry query",
      topic: "general" as const,
      maxResults: 2,
      excludeDomains: [],
    };

    await expect(provider.search(request)).rejects.toThrow("temporary failure");
    const controller = new AbortController();
    const aborted = provider.search({ ...request, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await expect(provider.search(request)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects an already-aborted signal without touching Exa", async () => {
    const fetchMock = vi.fn();
    const provider = new ExaSearchProvider({ apiKey: "test-key", fetch: fetchMock });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.search({
        query: "aborted",
        topic: "general",
        maxResults: 1,
        excludeDomains: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Exa Contents to read full text for selected search URLs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith("/contents")) {
        return Response.json({
          results: [
            {
              id: "full-source",
              title: "Full public record",
              url: "https://example.gov/full-record",
              text: "This is the full source text used to ground a final citation.",
              highlights: ["A shorter highlight."],
            },
          ],
        });
      }
      return Response.json({ results: [] });
    });
    const provider = new ExaSearchProvider({
      apiKey: "test-key",
      fetch: fetchMock,
    });

    const results = await provider.contents({
      urls: ["https://example.gov/full-record"],
      query: "ground the central claim",
    });

    expect(results[0]?.content).toBe(
      "This is the full source text used to ground a final citation.",
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.exa.ai/contents");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      ids: ["https://example.gov/full-record"],
      text: true,
      highlights: {
        query: "ground the central claim",
        numSentences: 4,
        highlightsPerUrl: 3,
      },
    });
  });

  it("passes an explicit deep mode through to Exa", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ results: [] }),
    );
    const provider = new ExaSearchProvider({ apiKey: "test-key", fetch: fetchMock });

    await provider.search({
      query: "difficult unresolved question",
      topic: "general",
      maxResults: 5,
      excludeDomains: [],
      mode: "deep",
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "difficult unresolved question",
      type: "deep",
    });
  });
});
