import { describe, expect, it } from "vitest";
import { shouldRenderSection } from "./Section";

describe("section visibility", () => {
  it("hides completed empty research sections without hiding loading or errors", () => {
    expect(shouldRenderSection("empty")).toBe(false);
    expect(shouldRenderSection("loading")).toBe(true);
    expect(shouldRenderSection("ready")).toBe(true);
    expect(shouldRenderSection("error")).toBe(true);
  });
});
