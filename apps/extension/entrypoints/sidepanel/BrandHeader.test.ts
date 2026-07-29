import { describe, expect, it } from "vitest";
import { shouldCompactMasthead } from "./BrandHeader";

describe("shouldCompactMasthead", () => {
  it("keeps the full masthead near the article header and compacts it while reading", () => {
    expect(shouldCompactMasthead(96)).toBe(false);
    expect(shouldCompactMasthead(97)).toBe(true);
  });
});
