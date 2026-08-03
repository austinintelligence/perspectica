import type { AnalysisReasoningEffort } from "@perspectica/contracts";
import { ANALYSIS_LIMITS, type AnalysisBudgetMode } from "@perspectica/contracts/limits";

export interface AnalysisBudget {
  mode: AnalysisBudgetMode;
  deepPassageCharacters: number;
  maxClaims: number;
  maxMissions: number;
  maxSources: number;
  maxConcurrency: number;
  totalDeadlineMs: number;
  modelOutputTokens: number;
  reasoningEffort: AnalysisReasoningEffort;
}

export function resolveAnalysisBudget(
  mode: AnalysisBudgetMode = "balanced",
  reasoningEffort: AnalysisReasoningEffort = "medium",
): AnalysisBudget {
  const limits = ANALYSIS_LIMITS[mode];
  return {
    ...limits,
    mode,
    reasoningEffort,
    modelOutputTokens: mode === "fast" ? 1_600 : mode === "deep" ? 3_000 : 2_200,
  };
}
