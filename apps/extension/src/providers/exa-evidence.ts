import type {
  EvidenceBatch,
  EvidenceRetriever,
  RetrievalPlan,
  RetrievalMission,
  EvidenceCard,
} from "@perspectica/contracts/evidence";
import { normalizeCanonicalUrl } from "@perspectica/contracts/url";
import { runPriorityTasks } from "@perspectica/intelligence";
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

function relationship(mission: RetrievalMission): EvidenceCard["relationship"] {
  if (mission.purpose === "correction-or-qualification") return "qualifies";
  if (mission.purpose === "primary-record" || mission.purpose === "independent-verification")
    return "supports";
  if (mission.purpose === "comparable-coverage") return "adds-context";
  return "adds-context";
}

function sourceType(url: string): EvidenceCard["sourceType"] {
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
  private readonly cache = new Map<string, { expiresAt: number; results: EvidenceCard[] }>();

  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly onDiagnostics?: (diagnostics: ExaEvidenceDiagnostics) => void,
    private readonly persistentCache?: EvidenceResultCache,
  ) {}

  private async search(mission: RetrievalMission, signal: AbortSignal): Promise<EvidenceBatch> {
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
      this.onDiagnostics?.({
        missionId: mission.id,
        durationMs: Date.now() - startedAt,
        resultCount: cached.results.length,
        cacheHit: true,
        outcome: "ready",
      });
      return {
        missionId: mission.id,
        provider: "exa",
        cards: cached.results,
        searched: true,
        cacheHit: true,
        durationMs: Date.now() - startedAt,
      };
    }
    const persisted = await this.persistentCache?.get<EvidenceCard[]>(cacheKey);
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
        cards: persisted,
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
    const cards: EvidenceCard[] = parsed.results.flatMap((raw) => {
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
          missionId: mission.id,
          claimId: mission.claimIds[0] ?? null,
          sourceUrl: url,
          title: result.data.title?.trim() || publication(url),
          publication: publication(url),
          publishedAt: publishedAt(result.data.publishedDate),
          statement: excerpt,
          excerpt,
          content,
          contentKind: "source-text",
          relationship: relationship(mission),
          sourceType: sourceType(url),
          confidence: Math.max(0.35, Math.min(0.95, result.data.score ?? 0.65)),
          provider: "exa",
        } satisfies EvidenceCard,
      ];
    });
    this.cache.set(cacheKey, { expiresAt: Date.now() + 24 * 60 * 60_000, results: cards });
    await this.persistentCache?.set(cacheKey, cards, 24 * 60 * 60_000);
    if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value ?? "");
    this.onDiagnostics?.({
      missionId: mission.id,
      durationMs: Date.now() - startedAt,
      resultCount: cards.length,
      cacheHit: false,
      outcome: "ready",
    });
    return {
      missionId: mission.id,
      provider: "exa",
      cards,
      searched: true,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    };
  }

  async *retrieve(plan: RetrievalPlan, signal: AbortSignal): AsyncIterable<EvidenceBatch> {
    const tasks = [...plan.missions]
      .sort((left, right) => right.priority - left.priority)
      .map((mission) => ({
        priority: mission.priority,
        run: async (): Promise<EvidenceBatch> => {
          const startedAt = Date.now();
          try {
            return await this.search(mission, signal);
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
              cards: [],
              searched: true,
              cacheHit: false,
              durationMs: Date.now() - startedAt,
            };
          }
        },
      }));
    const batches = await runPriorityTasks(tasks, plan.maxConcurrency, signal);
    for (const batch of batches) {
      yield batch;
      if (Date.now() >= plan.deadlineAt) break;
    }
  }
}
