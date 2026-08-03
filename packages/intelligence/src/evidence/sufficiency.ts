import type { AnalysisBudget } from "../budgets";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import type {
  EvidenceAssertion,
  SourceLedgerSnapshot,
  SufficiencySnapshot,
} from "@perspectica/contracts/evidence";

export function evaluateSufficiency(
  plan: AnalysisPlan,
  assertions: readonly EvidenceAssertion[],
  completedMissions: number,
  budget: AnalysisBudget,
  candidateCount = 0,
): SufficiencySnapshot {
  const covered = new Set(
    assertions.flatMap((assertion) => (assertion.claimId ? [assertion.claimId] : [])),
  );
  const meaningfulContradiction = assertions.some(
    (assertion) =>
      assertion.relationship === "contradicts" || assertion.relationship === "qualifies",
  );
  const coverage = plan.claims.length === 0 ? 1 : covered.size / plan.claims.length;
  const stop =
    assertions.length >= budget.maxSources ||
    (coverage >= (budget.mode === "fast" ? 0.6 : budget.mode === "balanced" ? 0.75 : 0.9) &&
      completedMissions >= Math.min(2, plan.missions.length)) ||
    completedMissions >= plan.missions.length;
  return {
    acceptedSources: new Set(assertions.map((assertion) => assertion.sourceId)).size,
    acceptedAssertions: assertions.length,
    coveredClaims: covered.size,
    totalClaims: plan.claims.length,
    meaningfulContradiction,
    exhaustedMissions: completedMissions,
    candidateCount,
    stop,
    reason: stop
      ? coverage >= 0.75
        ? "Central claims have responsible coverage."
        : "The bounded mission budget was exhausted."
      : `${Math.round(coverage * 100)}% of planned claims have evidence coverage.`,
  };
}

export function isLedgerSufficient(snapshot: SourceLedgerSnapshot): boolean {
  return snapshot.sufficiency.stop;
}
