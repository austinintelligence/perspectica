import type {
  ResearchSearchProvider,
  ResearchContentsRequest,
  ResearchSearchRequest,
  ResearchSearchResult,
} from "@perspectica/analysis/research-ai-sdk";
import { z } from "zod";

const DEFAULT_EXA_ENDPOINT = "https://api.exa.ai/search";
const DEFAULT_EXA_CONTENTS_ENDPOINT = "https://api.exa.ai/contents";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DEEP_TIMEOUT_MS = 45_000;
const DEFAULT_CONTENTS_TIMEOUT_MS = 25_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_CONTENT_CHARACTERS = 16_000;

const ExaResultSchema = z.object({
  id: z.string().optional(),
  title: z.string().nullish(),
  url: z.string(),
  publishedDate: z.string().nullish(),
  score: z.number().nullish(),
  text: z.string().nullish(),
  highlights: z.array(z.string()).nullish(),
});

const ExaSearchResponseSchema = z.object({
  results: z.array(ExaResultSchema),
});

type FetchImplementation = typeof fetch;

export interface ExaSearchCacheEntry {
  expiresAt: number;
  promise: Promise<ResearchSearchResult[]>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

export type ExaSearchCache = Map<string, ExaSearchCacheEntry>;

export interface ExaSearchProviderOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  deepTimeoutMs?: number;
  contentsEndpoint?: string;
  contentsTimeoutMs?: number;
  fetch?: FetchImplementation;
  cacheTtlMs?: number;
  cache?: ExaSearchCache;
  now?: () => number;
}

function boundedResultCount(value: number): number {
  return Math.max(1, Math.min(Math.floor(value), 10));
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sourceContent(result: z.infer<typeof ExaResultSchema>): string {
  const highlights = (result.highlights ?? []).map((highlight) => highlight.trim()).filter(Boolean);
  const content = highlights.length > 0 ? highlights.join("\n\n") : (result.text?.trim() ?? "");
  return content.slice(0, MAX_CONTENT_CHARACTERS);
}

function fullSourceContent(result: z.infer<typeof ExaResultSchema>): string {
  const text = result.text?.trim();
  return (text || sourceContent(result)).slice(0, MAX_CONTENT_CHARACTERS);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Search aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cacheKey(request: ResearchSearchRequest): string {
  return JSON.stringify({
    operation: "search",
    query: request.query,
    topic: request.topic,
    maxResults: request.maxResults,
    excludeDomains: [...request.excludeDomains].sort(),
    includeDomains: [...(request.includeDomains ?? [])].sort(),
    mode: request.mode ?? "fast",
  });
}

function contentsCacheKey(request: ResearchContentsRequest): string {
  return JSON.stringify({
    operation: "contents",
    urls: [...request.urls].sort(),
    query: request.query ?? "",
  });
}

export class ExaSearchProvider implements ResearchSearchProvider {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly deepTimeoutMs: number;
  private readonly contentsEndpoint: string;
  private readonly contentsTimeoutMs: number;
  private readonly fetchImplementation: FetchImplementation;
  private readonly cacheTtlMs: number;
  private readonly cache: ExaSearchCache;
  private readonly now: () => number;

  constructor(options: ExaSearchProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.endpoint = options.endpoint ?? DEFAULT_EXA_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deepTimeoutMs = options.deepTimeoutMs ?? DEFAULT_DEEP_TIMEOUT_MS;
    this.contentsEndpoint = options.contentsEndpoint ?? DEFAULT_EXA_CONTENTS_ENDPOINT;
    this.contentsTimeoutMs = options.contentsTimeoutMs ?? DEFAULT_CONTENTS_TIMEOUT_MS;
    this.fetchImplementation = options.fetch ?? fetch;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.cache = options.cache ?? new Map();
    this.now = options.now ?? Date.now;
  }

  private async fetchSearch(request: ResearchSearchRequest): Promise<ResearchSearchResult[]> {
    if (request.signal?.aborted) {
      throw abortError(request.signal);
    }
    if (!this.apiKey) {
      throw new Error(
        "Exa search is not configured. Set EXA_API_KEY in apps/api/.env.local and restart the API.",
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const requestTimeoutMs = request.mode === "deep" ? this.deepTimeoutMs : this.timeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    const abortFromParent = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (request.signal?.aborted) abortFromParent();

    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          query: request.query,
          type: request.mode ?? "fast",
          numResults: boundedResultCount(request.maxResults),
          excludeDomains: request.excludeDomains,
          ...(request.includeDomains && request.includeDomains.length > 0
            ? { includeDomains: request.includeDomains }
            : {}),
          contents: {
            highlights: true,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 400);
        throw new Error(
          `Exa search failed with status ${response.status}${detail ? `: ${detail}` : "."}`,
        );
      }

      const parsed = ExaSearchResponseSchema.parse(await response.json());
      return parsed.results
        .map((result, index): ResearchSearchResult | null => {
          const content = sourceContent(result);
          if (!validHttpUrl(result.url) || !content) return null;
          return {
            id: result.id?.trim() || `exa-${index + 1}`,
            title: result.title?.trim() || "Untitled source",
            url: result.url,
            content,
            publishedAt: result.publishedDate?.trim() || null,
            score: result.score ?? null,
          };
        })
        .filter((result): result is ResearchSearchResult => result !== null);
    } catch (error) {
      if (timedOut) {
        throw new Error(`Exa search exceeded ${Math.round(requestTimeoutMs / 1_000)} seconds.`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromParent);
    }
  }

  private async fetchContents(request: ResearchContentsRequest): Promise<ResearchSearchResult[]> {
    if (request.signal?.aborted) throw abortError(request.signal);
    if (!this.apiKey) {
      throw new Error(
        "Exa search is not configured. Set EXA_API_KEY in apps/api/.env.local and restart the API.",
      );
    }

    const urls = [...new Set(request.urls.filter(validHttpUrl))].slice(0, 4);
    if (urls.length === 0) return [];
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.contentsTimeoutMs);
    const abortFromParent = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (request.signal?.aborted) abortFromParent();

    try {
      const response = await this.fetchImplementation(this.contentsEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          ids: urls,
          text: true,
          highlights: {
            ...(request.query?.trim() ? { query: request.query.trim().slice(0, 390) } : {}),
            numSentences: 4,
            highlightsPerUrl: 3,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 400);
        throw new Error(
          `Exa contents failed with status ${response.status}${detail ? `: ${detail}` : "."}`,
        );
      }
      const parsed = ExaSearchResponseSchema.parse(await response.json());
      return parsed.results
        .map((result, index): ResearchSearchResult | null => {
          const content = fullSourceContent(result);
          if (!validHttpUrl(result.url) || !content) return null;
          return {
            id: result.id?.trim() || `exa-content-${index + 1}`,
            title: result.title?.trim() || "Untitled source",
            url: result.url,
            content,
            publishedAt: result.publishedDate?.trim() || null,
            score: result.score ?? null,
          };
        })
        .filter((result): result is ResearchSearchResult => result !== null);
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `Exa source reading exceeded ${Math.round(this.contentsTimeoutMs / 1_000)} seconds.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromParent);
    }
  }

  private consume(
    key: string,
    entry: ExaSearchCacheEntry,
    signal?: AbortSignal,
  ): Promise<ResearchSearchResult[]> {
    entry.consumers += 1;
    return withAbort(entry.promise, signal).finally(() => {
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (entry.consumers === 0 && !entry.settled) {
        if (this.cache.get(key) === entry) this.cache.delete(key);
        entry.controller.abort();
      }
    });
  }

  async search(request: ResearchSearchRequest): Promise<ResearchSearchResult[]> {
    if (request.signal?.aborted) {
      throw abortError(request.signal);
    }

    const key = cacheKey(request);
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return this.consume(key, cached, request.signal);
    }
    if (cached) this.cache.delete(key);

    const controller = new AbortController();
    const promise = this.fetchSearch({ ...request, signal: controller.signal });
    const entry: ExaSearchCacheEntry = {
      expiresAt: now + this.cacheTtlMs,
      promise,
      controller,
      consumers: 0,
      settled: false,
    };
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.cache.delete(oldestKey);
    }
    promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
        if (this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
    return this.consume(key, entry, request.signal);
  }

  async contents(request: ResearchContentsRequest): Promise<ResearchSearchResult[]> {
    if (request.signal?.aborted) throw abortError(request.signal);
    const key = contentsCacheKey(request);
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return this.consume(key, cached, request.signal);
    }
    if (cached) this.cache.delete(key);

    const controller = new AbortController();
    const promise = this.fetchContents({ ...request, signal: controller.signal });
    const entry: ExaSearchCacheEntry = {
      expiresAt: now + this.cacheTtlMs,
      promise,
      controller,
      consumers: 0,
      settled: false,
    };
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.cache.delete(oldestKey);
    }
    promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
        if (this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
    return this.consume(key, entry, request.signal);
  }
}
