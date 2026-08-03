import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchSetupScreen } from "./SearchSetupScreen";
import { DEFAULT_ANALYSIS_PREFERENCES } from "./preferences";

describe("SearchSetupScreen", () => {
  it("offers the full provider ladder and a focusable route heading", () => {
    const html = renderToStaticMarkup(
      createElement(SearchSetupScreen, {
        preferences: {
          ...DEFAULT_ANALYSIS_PREFERENCES,
          mode: "balanced",
          searchProvider: "free",
          rememberChatGpt: true,
        },
        onChange: async () => undefined,
        onReady: () => undefined,
        onOpenSettings: () => undefined,
      }),
    );

    expect(html).toContain('data-route-heading="true"');
    expect(html).toContain("Free");
    expect(html).toContain("ChatGPT search");
    expect(html).toContain("Exa");
    expect(html).toContain('aria-checked="true"');
  });
});
