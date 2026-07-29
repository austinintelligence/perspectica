import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressiveText } from "./ProgressiveText";

describe("ProgressiveText", () => {
  it("renders one accessible text copy while animating its chunks", () => {
    const text = "One sentence should only exist once.";
    const markup = renderToStaticMarkup(createElement(ProgressiveText, { text }));
    const visibleText = markup.replace(/<[^>]*>/g, "").replaceAll("&quot;", '"');

    expect(visibleText).toBe(text);
    expect(markup).not.toContain("sr-only");
    expect(markup).not.toContain('aria-hidden="true"');
    expect(markup).toContain("One</span> <span");
  });
});
