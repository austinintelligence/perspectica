import { z } from "zod";
import { AnalysisModelSchema, AnalysisReasoningEffortSchema } from "./index";
import { ANALYSIS_LIMITS } from "./limits";

export const AnalysisModeSchema = z.enum(["fast", "balanced", "deep"]);
export type AnalysisMode = z.infer<typeof AnalysisModeSchema>;

export const V2AnalysisPreferencesSchema = z.object({
  model: AnalysisModelSchema,
  reasoningEffort: AnalysisReasoningEffortSchema,
  mode: AnalysisModeSchema,
});
export type V2AnalysisPreferences = z.infer<typeof V2AnalysisPreferencesSchema>;

export function budgetForMode(mode: AnalysisMode) {
  return ANALYSIS_LIMITS[mode];
}
