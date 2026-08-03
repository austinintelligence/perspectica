import { describe, expect, it } from "vitest";
import { recommendedInferenceForDepth, usesCustomInference } from "./preferences";

describe("research depth inference defaults", () => {
  it.each([
    ["quick", "gpt-5.4", "low"],
    ["balanced", "gpt-5.6-luna", "medium"],
    ["deep", "gpt-5.6-luna", "high"],
    ["verified", "gpt-5.6-sol", "high"],
  ] as const)("maps %s to its recommended inference", (depth, model, reasoningEffort) => {
    expect(recommendedInferenceForDepth(depth)).toEqual({ model, reasoningEffort });
  });

  it("recognizes advanced overrides as custom", () => {
    expect(
      usesCustomInference("balanced", {
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
      }),
    ).toBe(false);
    expect(
      usesCustomInference("balanced", {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      }),
    ).toBe(true);
  });
});
