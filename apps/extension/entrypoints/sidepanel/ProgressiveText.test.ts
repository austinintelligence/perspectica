import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressiveText } from "./ProgressiveText";

describe("ProgressiveText", () => {
  it("renders text once without per-word animation", () => {
    const text = "One sentence should only exist once.";
    const markup = renderToStaticMarkup(createElement(ProgressiveText, { text }));
    const visibleText = markup.replace(/<[^>]*>/g, "");

    expect(visibleText).toBe(text);
    expect(markup).toBe(`<span class="progressive-text">${text}</span>`);
    expect(markup).not.toContain("motion");
  });
});
