import { z } from "zod";
import { AnalysisModelSchema, AnalysisReasoningEffortSchema } from "./index";
import { ANALYSIS_LIMITS } from "./limits";

const CanonicalAnalysisModeSchema = z.enum(["quick", "balanced", "deep", "verified"]);

/** `fast` was the pre-depth name for `quick`; parse it only at migration edges. */
export const AnalysisModeSchema = z.preprocess(
  (value) => (value === "fast" ? "quick" : value),
  CanonicalAnalysisModeSchema,
);
export type AnalysisMode = z.infer<typeof CanonicalAnalysisModeSchema>;
export type LegacyAnalysisMode = "fast";

export const V2AnalysisPreferencesSchema = z.object({
  model: AnalysisModelSchema,
  reasoningEffort: AnalysisReasoningEffortSchema,
  mode: AnalysisModeSchema,
});
export type V2AnalysisPreferences = z.infer<typeof V2AnalysisPreferencesSchema>;

export function budgetForMode(mode: AnalysisMode | LegacyAnalysisMode) {
  return ANALYSIS_LIMITS[mode === "fast" ? "quick" : mode];
}
