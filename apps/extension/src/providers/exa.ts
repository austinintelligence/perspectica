import type {
  ResearchContentsRequest,
  ResearchSearchProvider,
  ResearchSearchRequest,
  ResearchSearchResult,
} from "@perspectica/analysis/research-ai-sdk";
import { normalizeCanonicalUrl } from "@perspectica/contracts";
import { z } from "zod";
import { RequestGate } from "./request-gate";

const ExaResultSchema = z.object({
  id: z.string().trim().max(256).optional(),
  title: z.string().trim().max(1_000).nullish(),
  url: z.string().url().max(4_096),
  publishedDate: z.string().trim().max(128).nullish(),
  score: z.number().finite().nullish(),
  text: z.string().max(32_000).nullish(),
  highlights: z.array(z.string().max(8_000)).max(16).nullish(),
});
const ExaResponseSchema = z.object({ results: z.array(z.unknown()).max(50) });
const MAX_CONTENT_CHARACTERS = 16_000;
const MAX_RESPONSE_CHARACTERS = 2_000_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_TOTAL_REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAY_BUDGET_MS = 4_000;

interface CachedRequest {
  expiresAt: number;
  promise: Promise<ResearchSearchResult[]>;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, cancellation]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

export interface ExaRequestDiagnostics {
  endpoint: "search" | "contents";
  attempt: number;
  outcome: "ready" | "retrying" | "failed";
  durationMs: number;
  queueMs?: number;
  status?: number;
  resultCount?: number;
  error?: string;
}

export class ExaSearchProvider implements ResearchSearchProvider {
  private readonly cache = new Map<string, CachedRequest>();
  private readonly requestGate = new RequestGate(2);

  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly onDiagnostics?: (diagnostics: ExaRequestDiagnostics) => void,
    private readonly requestTimeoutMs = 45_000,
  ) {}

  private get totalRequestTimeoutMs(): number {
    return Math.min(
      MAX_TOTAL_REQUEST_TIMEOUT_MS,
      this.requestTimeoutMs * MAX_ATTEMPTS + RETRY_DELAY_BUDGET_MS,
    );
  }

  private requestSignal(
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  private async waitBeforeRetry(attempt: number, response?: Response, signal?: AbortSignal) {
    const retryAfter = response?.headers.get("retry-after");
    const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(5_000, Math.max(0, retryAfterSeconds * 1_000))
      : Math.min(2_000, 300 * 2 ** attempt);
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private cached(
    key: string,
    load: () => Promise<ResearchSearchResult[]>,
  ): Promise<ResearchSearchResult[]> {
    const existing = this.cache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    const promise = load().catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    // A caller may abandon its waiter while the shared request continues. Keep
    // an observer attached so a later provider failure is not an unhandled
    // rejection when all current callers have already cancelled.
    void promise.catch(() => undefined);
    this.cache.set(key, { expiresAt: Date.now() + 5 * 60_000, promise });
    if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value ?? "");
    return promise;
  }

  private async post(
    endpoint: "search" | "contents",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<ResearchSearchResult[]> {
    if (!this.apiKey.trim()) throw new Error("Add an Exa API key in Perspectica settings.");
    const totalController = new AbortController();
    const onAbort = () => totalController.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) totalController.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const totalTimer = setTimeout(
      () => totalController.abort(new DOMException("The Exa request timed out.", "TimeoutError")),
      this.totalRequestTimeoutMs,
    );
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const attemptStartedAt = Date.now();
        const request = this.requestSignal(totalController.signal);
        let queueMs = 0;
        let response: Response;
        try {
          response = await this.requestGate.run(
            () =>
              this.fetchImplementation(`https://api.exa.ai/${endpoint}`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": this.apiKey,
                },
                body: JSON.stringify(body),
                signal: request.signal,
              }),
            totalController.signal,
            (diagnostics) => {
              queueMs = diagnostics.queueMs;
            },
          );
        } catch (error) {
          request.cleanup();
          if (totalController.signal.aborted) throw error;
          if (attempt + 1 < MAX_ATTEMPTS) {
            this.onDiagnostics?.({
              endpoint,
              attempt: attempt + 1,
              outcome: "retrying",
              durationMs: Date.now() - attemptStartedAt,
              queueMs,
              error: error instanceof Error ? error.message : String(error),
            });
            await this.waitBeforeRetry(attempt, undefined, totalController.signal);
            continue;
          }
          this.onDiagnostics?.({
            endpoint,
            attempt: attempt + 1,
            outcome: "failed",
            durationMs: Date.now() - attemptStartedAt,
            queueMs,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new Error(
            `Exa ${endpoint} is temporarily unavailable after ${MAX_ATTEMPTS} attempts.`,
            {
              cause: error,
            },
          );
        }
        if (!response.ok) {
          request.cleanup();
          const detail = (await response.text()).trim().slice(0, 240);
          if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < MAX_ATTEMPTS) {
            this.onDiagnostics?.({
              endpoint,
              attempt: attempt + 1,
              outcome: "retrying",
              durationMs: Date.now() - attemptStartedAt,
              queueMs,
              status: response.status,
              ...(detail ? { error: detail } : {}),
            });
            await this.waitBeforeRetry(attempt, response, totalController.signal);
            continue;
          }
          this.onDiagnostics?.({
            endpoint,
            attempt: attempt + 1,
            outcome: "failed",
            durationMs: Date.now() - attemptStartedAt,
            queueMs,
            status: response.status,
            ...(detail ? { error: detail } : {}),
          });
          throw new Error(
            `Exa ${endpoint} failed (${response.status})${detail ? `: ${detail}` : "."}`,
          );
        }
        request.cleanup();
        const responseText = await response.text();
        if (responseText.length > MAX_RESPONSE_CHARACTERS) {
          throw new Error(`Exa ${endpoint} returned an oversized response.`);
        }
        const parsed = ExaResponseSchema.parse(JSON.parse(responseText));
        const results = parsed.results.flatMap((rawResult, index) => {
          const parsedResult = ExaResultSchema.safeParse(rawResult);
          if (!parsedResult.success) return [];
          const result = parsedResult.data;
          const url = normalizeCanonicalUrl(result.url);
          if (!url) return [];
          const content = (
            (result.highlights ?? []).filter(Boolean).join("\n\n") ||
            result.text ||
            ""
          )
            .trim()
            .slice(0, MAX_CONTENT_CHARACTERS);
          if (!content) return [];
          return [
            {
              id: result.id?.trim() || `exa-${endpoint}-${index + 1}`,
              title: result.title?.trim() || "Untitled source",
              url,
              content,
              publishedAt: result.publishedDate?.trim() || null,
              score: result.score ?? null,
              contentKind: "source-text",
            } satisfies ResearchSearchResult,
          ];
        });
        this.onDiagnostics?.({
          endpoint,
          attempt: attempt + 1,
          outcome: "ready",
          durationMs: Date.now() - attemptStartedAt,
          queueMs,
          status: response.status,
          resultCount: results.length,
        });
        return results;
      }
      throw new Error(`Exa ${endpoint} did not return a response.`);
    } finally {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  search(request: ResearchSearchRequest): Promise<ResearchSearchResult[]> {
    const key = JSON.stringify({
      operation: "search",
      query: request.query,
      mode: request.mode,
      maxResults: request.maxResults,
      includeDomains: request.includeDomains,
      excludeDomains: request.excludeDomains,
    });
    const shared = this.cached(key, () =>
      this.post(
        "search",
        {
          query: request.query.slice(0, 390),
          type: request.mode ?? "fast",
          numResults: Math.max(1, Math.min(10, Math.floor(request.maxResults))),
          excludeDomains: request.excludeDomains,
          ...(request.includeDomains?.length ? { includeDomains: request.includeDomains } : {}),
          contents: {
            text: { maxCharacters: MAX_CONTENT_CHARACTERS },
            highlights: { numSentences: 4, highlightsPerUrl: 3 },
          },
        },
        undefined,
      ),
    );
    return abortable(shared, request.signal);
  }

  contents(request: ResearchContentsRequest): Promise<ResearchSearchResult[]> {
    const urls = [...new Set(request.urls)].slice(0, 4);
    if (urls.length === 0) return Promise.resolve([]);
    const key = JSON.stringify({ operation: "contents", urls, query: request.query });
    const shared = this.cached(key, () =>
      this.post(
        "contents",
        {
          ids: urls,
          text: { maxCharacters: MAX_CONTENT_CHARACTERS },
          highlights: {
            ...(request.query?.trim() ? { query: request.query.trim().slice(0, 390) } : {}),
            numSentences: 4,
            highlightsPerUrl: 3,
          },
        },
        undefined,
      ),
    );
    return abortable(shared, request.signal);
  }
}
