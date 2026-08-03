import type {
  EvidenceBatch,
  EvidenceRetriever,
  RetrievalPlan,
} from "@perspectica/contracts/evidence";
import type { AnalysisPlan, ReportSection } from "@perspectica/contracts/report";
import type { AnalysisBudget } from "../budgets";
import { EvidenceLedger } from "../evidence/source-ledger";

export interface RetrievalProgress {
  batch: EvidenceBatch;
  candidateCount: number;
  completedMissions: number;
  totalMissions: number;
  ledger: EvidenceLedger;
}

export interface RetrievalCoordinatorOptions {
  retriever: EvidenceRetriever;
  plan: AnalysisPlan;
  ledger: EvidenceLedger;
  budget: AnalysisBudget;
  signal: AbortSignal;
  now?: () => number;
}

export async function* runRetrieval(
  options: RetrievalCoordinatorOptions,
): AsyncGenerator<RetrievalProgress> {
  const retrievalPlan: RetrievalPlan = {
    missions: options.plan.missions.map((mission) => ({
      id: mission.id,
      claimIds: mission.claimIds,
      purpose: mission.purpose,
      queryVariants: mission.queryVariants,
      priority: mission.priority,
      estimatedCost: mission.estimatedCost,
      freshness: mission.freshness,
      preferredSourceTypes:
        mission.preferredSourceTypes as RetrievalPlan["missions"][number]["preferredSourceTypes"],
      includeDomains: mission.includeDomains,
      excludeDomains: mission.excludeDomains,
      canServeSections: mission.canServeSections,
    })),
    maxSources: options.budget.maxSources,
    maxConcurrency: options.budget.maxConcurrency,
    deadlineAt: (options.now ?? Date.now)() + options.budget.totalDeadlineMs,
  };
  for await (const batch of options.retriever.retrieve(retrievalPlan, options.signal)) {
    if (options.signal.aborted)
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Aborted", "AbortError");
    options.ledger.accept(batch);
    const candidateCount = options.ledger.getCandidates().length;
    yield {
      batch,
      candidateCount,
      completedMissions: options.ledger.completedMissionCount(),
      totalMissions: options.plan.missions.length,
      ledger: options.ledger,
    };
    // Retrieval remains streaming, but every planned mission is allowed to
    // settle before adjudication so an unattempted lane is never reported as
    // an honestly empty section. Provider-level deadlines and concurrency
    // still bound the work.
  }
}

export interface TargetedRetryOptions extends RetrievalCoordinatorOptions {
  sections: readonly ReportSection[];
}

/**
 * Reuses the existing index, plan, ledger, and accepted graph while rerunning
 * only missions that can serve a currently empty section. This is intentionally
 * separate from runRetrieval so a retry cannot accidentally restart the
 * complete article analysis.
 */
export async function* retryMissingSections(
  options: TargetedRetryOptions,
): AsyncGenerator<RetrievalProgress> {
  const requested = new Set(options.sections);
  const missions = options.plan.missions.filter(
    (mission) =>
      mission.canServeSections.some((section) => requested.has(section)) &&
      options.ledger.isMissionFailed(mission.id),
  );
  if (missions.length === 0) return;
  yield* runRetrieval({ ...options, plan: { ...options.plan, missions } });
}
