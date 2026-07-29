import {
  AnalysisPreferencesSchema,
  type AnalysisModel,
  type AnalysisPreferences,
  type AnalysisReasoningEffort,
} from "@perspectica/contracts";

const STORAGE_KEY = "perspectica.analysis-preferences.v1";

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

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function availableStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readAnalysisPreferences(
  storage: StorageLike | null = availableStorage(),
): AnalysisPreferences {
  if (!storage) return DEFAULT_ANALYSIS_PREFERENCES;

  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_ANALYSIS_PREFERENCES;
    const parsed = AnalysisPreferencesSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : DEFAULT_ANALYSIS_PREFERENCES;
  } catch {
    return DEFAULT_ANALYSIS_PREFERENCES;
  }
}

export function saveAnalysisPreferences(
  preferences: AnalysisPreferences,
  storage: StorageLike | null = availableStorage(),
): void {
  if (!storage) return;
  storage.setItem(STORAGE_KEY, JSON.stringify(AnalysisPreferencesSchema.parse(preferences)));
}
