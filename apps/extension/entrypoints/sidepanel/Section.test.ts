import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Section, shouldRenderSection } from "./Section";

describe("section visibility", () => {
  it("hides completed empty research sections without hiding loading or errors", () => {
    expect(shouldRenderSection("empty")).toBe(false);
    expect(shouldRenderSection("loading")).toBe(true);
    expect(shouldRenderSection("ready")).toBe(true);
    expect(shouldRenderSection("error")).toBe(true);
  });
});

it("exposes a targeted retry action for failed sections", () => {
  const html = renderToStaticMarkup(
    createElement(Section, {
      id: "supporting",
      title: "Supporting Information",
      status: "error",
      error: "The research lane failed.",
      onRetry: () => undefined,
      children: "unused",
    }),
  );

  expect(html).toContain("The research lane failed.");
  expect(html).toContain("Retry Supporting Information");
});
