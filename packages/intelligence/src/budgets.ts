import type { AnalysisReasoningEffort } from "@perspectica/contracts";
import { ANALYSIS_LIMITS, type AnalysisBudgetMode } from "@perspectica/contracts/limits";

export type LegacyAnalysisBudgetMode = "fast";

export interface AnalysisBudget {
  mode: AnalysisBudgetMode;
  deepPassageCharacters: number;
  maxClaims: number;
  maxMissions: number;
  maxSources: number;
  maxConcurrency: number;
  totalDeadlineMs: number;
  maxSearchQueries: number;
  maxSearchResults: number;
  maxSourceReads: number;
  maxModelSteps: number;
  maxArticleContextChars: number;
  maxSourceContextChars: number;
  specialistTimeoutMs: number;
  modelOutputTokens: number;
  reasoningEffort: AnalysisReasoningEffort;
}

function canonicalMode(mode: AnalysisBudgetMode | LegacyAnalysisBudgetMode): AnalysisBudgetMode {
  return mode === "fast" ? "quick" : mode;
}

export function resolveAnalysisBudget(
  mode: AnalysisBudgetMode | LegacyAnalysisBudgetMode = "balanced",
  reasoningEffort: AnalysisReasoningEffort = "medium",
): AnalysisBudget {
  const canonical = canonicalMode(mode);
  const limits = ANALYSIS_LIMITS[canonical];
  return {
    ...limits,
    mode: canonical,
    reasoningEffort,
    modelOutputTokens: limits.modelOutputTokens,
  };
}
