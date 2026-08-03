import type {
  EvidenceBatch,
  EvidenceProvider,
  EvidenceRetriever,
  RetrievalPlan,
} from "@perspectica/contracts/evidence";
import { EvidenceBatchSchema } from "@perspectica/contracts/evidence";

export interface ProviderFallbackDiagnostics {
  primaryProvider: Exclude<EvidenceProvider, "free">;
  fallbackProvider: "free";
  reason: "failed" | "empty";
  missionIds: string[];
  error?: string;
}

export type ProviderFallbackListener = (diagnostics: ProviderFallbackDiagnostics) => void;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function missionIdsForBatch(batch: EvidenceBatch, plan: RetrievalPlan): string[] {
  const covered = batch.coveredMissionIds.filter((id) =>
    plan.missions.some((mission) => mission.id === id),
  );
  if (covered.length > 0) return covered;
  return plan.missions.some((mission) => mission.id === batch.missionId) ? [batch.missionId] : [];
}

/**
 * Runs a configured provider first, then retries only failed/empty missions
 * through the bounded free provider. Provider identity remains on every
 * emitted batch so the fallback is visible to telemetry and adjudication.
 */
export class FallbackEvidenceRetriever implements EvidenceRetriever {
  constructor(
    private readonly primaryProvider: Exclude<EvidenceProvider, "free">,
    private readonly primary: EvidenceRetriever,
    private readonly fallback: EvidenceRetriever,
    private readonly onFallback?: ProviderFallbackListener,
  ) {}

  async *retrieve(plan: RetrievalPlan, signal: AbortSignal): AsyncIterable<EvidenceBatch> {
    const fallbackMissionIds = new Set<string>();
    const successfulMissionIds = new Set<string>();
    let primaryError: string | undefined;
    try {
      for await (const batch of this.primary.retrieve(plan, signal)) {
        yield batch;
        const missionIds = missionIdsForBatch(batch, plan);
        if (batch.status === "completed" && batch.candidates.length > 0) {
          for (const missionId of missionIds) {
            successfulMissionIds.add(missionId);
            fallbackMissionIds.delete(missionId);
          }
        } else {
          for (const missionId of missionIds) {
            if (!successfulMissionIds.has(missionId)) fallbackMissionIds.add(missionId);
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      primaryError = errorMessage(error);
      for (const mission of plan.missions) {
        if (!successfulMissionIds.has(mission.id)) fallbackMissionIds.add(mission.id);
      }
    }

    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (fallbackMissionIds.size === 0) return;

    const missionIds = [...fallbackMissionIds];
    this.onFallback?.({
      primaryProvider: this.primaryProvider,
      fallbackProvider: "free",
      reason: primaryError ? "failed" : "empty",
      missionIds,
      ...(primaryError ? { error: primaryError } : {}),
    });

    const fallbackPlan: RetrievalPlan = {
      ...plan,
      missions: plan.missions.filter((mission) => fallbackMissionIds.has(mission.id)),
    };
    const emittedMissionIds = new Set<string>();
    try {
      for await (const batch of this.fallback.retrieve(fallbackPlan, signal)) {
        yield batch;
        for (const missionId of missionIdsForBatch(batch, fallbackPlan))
          emittedMissionIds.add(missionId);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const message = `Free fallback failed: ${errorMessage(error)}`;
      for (const missionId of missionIds) {
        if (emittedMissionIds.has(missionId)) continue;
        yield EvidenceBatchSchema.parse({
          missionId,
          provider: "free",
          candidates: [],
          coveredMissionIds: [missionId],
          status: "failed",
          error: message,
          searched: true,
          cacheHit: false,
          durationMs: 0,
        });
      }
    }
  }
}
