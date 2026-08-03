import { describe, expect, it } from "vitest";
import { RESEARCH_DEPTH_OPTIONS } from "./DepthControl";

describe("research depth control", () => {
  it("exposes the four canonical depth choices in order", () => {
    expect(RESEARCH_DEPTH_OPTIONS.map((option) => option.value)).toEqual([
      "quick",
      "balanced",
      "deep",
      "verified",
    ]);
  });
});
