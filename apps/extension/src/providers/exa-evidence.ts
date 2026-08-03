import { EvidenceCandidateSchema } from "@perspectica/contracts/evidence";
import type {
  EvidenceCandidate,
  EvidenceBatch,
  EvidenceRetriever,
  RetrievalPlan,
} from "@perspectica/contracts/evidence";
import { normalizeCanonicalUrl } from "@perspectica/contracts/url";
import { runPriorityTasksStream, sourceIdFor } from "@perspectica/intelligence";
import type { EvidenceResultCache } from "../storage/evidence-cache";
import { z } from "zod";

const ExaResultSchema = z.object({
  title: z.string().trim().max(1_000).nullish(),
  url: z.string().url().max(4_096),
  publishedDate: z.string().trim().max(128).nullish(),
  text: z.string().max(32_000).nullish(),
  highlights: z.array(z.string().max(8_000)).max(16).nullish(),
  score: z.number().finite().nullish(),
});
const ExaResponseSchema = z.object({ results: z.array(z.unknown()).max(50) });

export interface ExaEvidenceDiagnostics {
  missionId: string;
  durationMs: number;
  resultCount: number;
  cacheHit: boolean;
  outcome: "ready" | "failed";
  error?: string;
}

function publication(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown publication";
  }
}

function sourceType(url: string): EvidenceCandidate["sourceType"] {
  return /\.(?:gov|mil|edu)(?:\.|\/|$)/i.test(url) ||
    /(?:record|filing|bill|data|report|pdf)/i.test(url)
    ? "primary-record"
    : "independent-reporting";
}

function publishedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

export class ExaEvidenceRetriever implements EvidenceRetriever {
  private readonly cache = new Map<string, { expiresAt: number; results: EvidenceCandidate[] }>();

  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly onDiagnostics?: (diagnostics: ExaEvidenceDiagnostics) => void,
    private readonly persistentCache?: EvidenceResultCache,
  ) {}

  private async search(
    mission: RetrievalPlan["missions"][number],
    signal: AbortSignal,
  ): Promise<EvidenceBatch> {
    if (signal.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Evidence retrieval deadline reached.", "TimeoutError");
    const startedAt = Date.now();
    const query = mission.queryVariants[0] ?? "independent context";
    const cacheKey = JSON.stringify({
      query,
      mission: mission.purpose,
      include: mission.includeDomains,
      exclude: mission.excludeDomains,
    });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const candidates = cached.results.map((candidate) => ({
        ...candidate,
        missionId: mission.id,
      }));
      this.onDiagnostics?.({
        missionId: mission.id,
        durationMs: Date.now() - startedAt,
        resultCount: candidates.length,
        cacheHit: true,
        outcome: "ready",
      });
      return {
        missionId: mission.id,
        provider: "exa",
        candidates,
        coveredMissionIds: [mission.id],
        status: "completed",
        error: null,
        searched: true,
        cacheHit: true,
        durationMs: Date.now() - startedAt,
      };
    }
    const persistedRaw = await this.persistentCache?.get<unknown[]>(cacheKey);
    const persisted = (persistedRaw ?? [])
      .map((candidate) => EvidenceCandidateSchema.safeParse(candidate))
      .flatMap((parsed) => (parsed.success ? [{ ...parsed.data, missionId: mission.id }] : []));
    if (persisted?.length) {
      this.cache.set(cacheKey, { expiresAt: Date.now() + 24 * 60 * 60_000, results: persisted });
      this.onDiagnostics?.({
        missionId: mission.id,
        durationMs: Date.now() - startedAt,
        resultCount: persisted.length,
        cacheHit: true,
        outcome: "ready",
      });
      return {
        missionId: mission.id,
        provider: "exa",
        candidates: persisted,
        coveredMissionIds: [mission.id],
        status: "completed",
        error: null,
        searched: false,
        cacheHit: true,
        durationMs: Date.now() - startedAt,
      };
    }
    if (!this.apiKey.trim()) throw new Error("Add an Exa API key in Perspectica settings.");
    const response = await this.fetchImplementation("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        query: query.slice(0, 390),
        type: "fast",
        numResults: 8,
        excludeDomains: mission.excludeDomains,
        ...(mission.includeDomains.length ? { includeDomains: mission.includeDomains } : {}),
        contents: {
          text: { maxCharacters: 12_000 },
          highlights: { numSentences: 4, highlightsPerUrl: 3 },
        },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Exa search failed (${response.status}).`);
    const parsed = ExaResponseSchema.parse(await response.json());
    const candidates: EvidenceCandidate[] = parsed.results.flatMap((raw) => {
      const result = ExaResultSchema.safeParse(raw);
      if (!result.success) return [];
      const url = normalizeCanonicalUrl(result.data.url);
      if (!url) return [];
      const content = (
        (result.data.highlights ?? []).filter(Boolean).join("\n\n") ||
        result.data.text ||
        ""
      )
        .trim()
        .slice(0, 20_000);
      if (!content) return [];
      const excerpt = (result.data.highlights?.[0] ?? content.slice(0, 360)).trim();
      return [
        {
          id: sourceIdFor(url, "candidate"),
          missionId: mission.id,
          sourceUrl: url,
          title: result.data.title?.trim() || publication(url),
          publication: publication(url),
          publishedAt: publishedAt(result.data.publishedDate),
          content,
          contentKind: "source-text",
          sourceType: sourceType(url),
          discoveryContext: null,
          discoveryExcerpt: excerpt,
          providerScore:
            result.data.score == null ? null : Math.max(0, Math.min(1, result.data.score)),
          provider: "exa",
        } satisfies EvidenceCandidate,
      ];
    });
    this.cache.set(cacheKey, { expiresAt: Date.now() + 24 * 60 * 60_000, results: candidates });
    await this.persistentCache?.set(cacheKey, candidates, 24 * 60 * 60_000);
    if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value ?? "");
    this.onDiagnostics?.({
      missionId: mission.id,
      durationMs: Date.now() - startedAt,
      resultCount: candidates.length,
      cacheHit: false,
      outcome: "ready",
    });
    return {
      missionId: mission.id,
      provider: "exa",
      candidates,
      coveredMissionIds: [mission.id],
      status: "completed",
      error: null,
      searched: true,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    };
  }

  async *retrieve(plan: RetrievalPlan, signal: AbortSignal): AsyncIterable<EvidenceBatch> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal.reason);
    if (signal.aborted) abortFromParent();
    else signal.addEventListener("abort", abortFromParent, { once: true });
    const deadlineTimer = setTimeout(
      () => {
        if (!controller.signal.aborted)
          controller.abort(
            new DOMException("Evidence retrieval deadline reached.", "TimeoutError"),
          );
      },
      Math.max(0, plan.deadlineAt - Date.now()),
    );
    const tasks = [...plan.missions]
      .sort((left, right) => right.priority - left.priority)
      .map((mission) => ({
        priority: mission.priority,
        run: async (): Promise<EvidenceBatch> => {
          const startedAt = Date.now();
          try {
            if (controller.signal.aborted)
              throw controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new DOMException("Evidence retrieval deadline reached.", "TimeoutError");
            return await this.search(mission, controller.signal);
          } catch (error) {
            if (signal.aborted) throw error;
            this.onDiagnostics?.({
              missionId: mission.id,
              durationMs: Date.now() - startedAt,
              resultCount: 0,
              cacheHit: false,
              outcome: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              missionId: mission.id,
              provider: "exa",
              candidates: [],
              coveredMissionIds: [mission.id],
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              searched: true,
              cacheHit: false,
              durationMs: Date.now() - startedAt,
            };
          }
        },
      }));
    try {
      for await (const batch of runPriorityTasksStream(tasks, plan.maxConcurrency, signal)) {
        yield batch;
      }
    } finally {
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", abortFromParent);
      controller.abort();
    }
  }
}
