import { describe, expect, it, vi } from "vitest";
import { ExaSearchProvider } from "./exa";

function successfulResponse(index = 1): Response {
  return new Response(
    JSON.stringify({
      results: [
        {
          id: `source-${index}`,
          title: "Source",
          url: `https://example.com/${index}`,
          text: "Useful source text.",
          score: 0.9,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function request(query: string) {
  return {
    query,
    topic: "news" as const,
    maxResults: 3,
    excludeDomains: [],
  };
}

describe("ExaSearchProvider", () => {
  it("retries temporary rate limits", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(successfulResponse());
    const provider = new ExaSearchProvider("test-key", fetchImplementation);

    await expect(provider.search(request("temporary error"))).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("retries transient network failures", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(successfulResponse());
    const provider = new ExaSearchProvider("test-key", fetchImplementation);

    await expect(provider.search(request("temporary network failure"))).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("limits a burst of research lanes to two active Exa requests", async () => {
    let active = 0;
    let maximumActive = 0;
    let responseIndex = 0;
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      responseIndex += 1;
      return successfulResponse(responseIndex);
    });
    const provider = new ExaSearchProvider("test-key", fetchImplementation);

    await Promise.all(
      Array.from({ length: 5 }, (_, index) => provider.search(request(`query-${index}`))),
    );

    expect(maximumActive).toBe(2);
    expect(fetchImplementation).toHaveBeenCalledTimes(5);
  });

  it("keeps a shared request alive when one waiter aborts", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchImplementation = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => (resolveResponse = resolve)),
    );
    const provider = new ExaSearchProvider("test-key", fetchImplementation);
    const firstAbort = new AbortController();
    const first = provider.search({ ...request("shared request"), signal: firstAbort.signal });
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    const second = provider.search(request("shared request"));

    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    resolveResponse(successfulResponse());

    await expect(second).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("drops oversized or credential-bearing results without failing the response", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              id: "credential-url",
              title: "Private URL",
              url: "https://reader:secret@example.com/story",
              text: "Should be dropped.",
            },
            {
              id: "oversized-title",
              title: "x".repeat(1_001),
              url: "https://example.com/oversized",
              text: "Should be dropped.",
            },
            {
              id: "safe",
              title: "Safe source",
              url: "https://example.com/story?token=secret&edition=us",
              text: "Safe source text.",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new ExaSearchProvider("test-key", fetchImplementation);

    await expect(provider.search(request("bounded results"))).resolves.toEqual([
      expect.objectContaining({
        id: "safe",
        url: "https://example.com/story?edition=us",
      }),
    ]);
  });

  it("does not retry invalid credentials", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("invalid key", { status: 401 }));
    const provider = new ExaSearchProvider("test-key", fetchImplementation);

    await expect(provider.search(request("invalid credentials"))).rejects.toThrow(
      "Exa search failed (401)",
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung Exa request instead of waiting forever", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        }),
    );
    const provider = new ExaSearchProvider("test-key", fetchImplementation, undefined, 1);

    await expect(provider.search(request("hung request"))).rejects.toThrow(
      "Exa search is temporarily unavailable after 3 attempts.",
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("exposes request queue timing through diagnostics", async () => {
    const diagnostics = vi.fn();
    const provider = new ExaSearchProvider(
      "test-key",
      vi.fn(async () => successfulResponse()),
      diagnostics,
    );

    await provider.search(request("diagnostics"));

    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "search",
        outcome: "ready",
        queueMs: expect.any(Number),
      }),
    );
  });
});
