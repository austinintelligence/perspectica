import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYSIS_PREFERENCES,
  readAnalysisPreferences,
  saveAnalysisPreferences,
} from "./preferences";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("analysis preferences", () => {
  it("returns defaults for missing or invalid saved values", () => {
    expect(readAnalysisPreferences(memoryStorage())).toEqual(DEFAULT_ANALYSIS_PREFERENCES);
    expect(readAnalysisPreferences(memoryStorage('{"model":"unknown"}'))).toEqual(
      DEFAULT_ANALYSIS_PREFERENCES,
    );
  });

  it("persists and restores a valid model and reasoning effort", () => {
    const storage = memoryStorage();
    const preferences = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;

    saveAnalysisPreferences(preferences, storage);

    expect(readAnalysisPreferences(storage)).toEqual(preferences);
  });
});
