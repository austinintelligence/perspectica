import type {
  AnalysisModel,
  AnalysisPreferences,
  AnalysisReasoningEffort,
  ResearchDepth,
} from "@perspectica/contracts";
import { researchProfileFor } from "@perspectica/contracts";

export const DEFAULT_ANALYSIS_PREFERENCES: AnalysisPreferences = {
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
};

export const ANALYSIS_MODELS: ReadonlyArray<{
  value: AnalysisModel;
  label: string;
  description: string;
}> = [
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "Fast agentic analysis for the full report.",
  },
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "Deeper agentic analysis for complex articles.",
  },
  {
    value: "gpt-5.4",
    label: "GPT-5.4",
    description: "Stable analysis with broad account compatibility.",
  },
];

export const REASONING_EFFORTS: ReadonlyArray<{
  value: AnalysisReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function recommendedInferenceForDepth(
  depth: ResearchDepth,
): Pick<AnalysisPreferences, "model" | "reasoningEffort"> {
  const profile = researchProfileFor(depth);
  return {
    model: profile.defaultModel,
    reasoningEffort: profile.defaultReasoningEffort,
  };
}

export function usesCustomInference(
  depth: ResearchDepth,
  preferences: Pick<AnalysisPreferences, "model" | "reasoningEffort">,
): boolean {
  const recommended = recommendedInferenceForDepth(depth);
  return (
    preferences.model !== recommended.model ||
    preferences.reasoningEffort !== recommended.reasoningEffort
  );
}
