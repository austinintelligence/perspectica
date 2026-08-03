import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYSIS_PREFERENCES } from "./preferences";
import { SettingsScreen } from "./SettingsScreen";

describe("SettingsScreen", () => {
  it("is an exclusive route rather than a modal overlay", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsScreen, {
        authenticated: true,
        preferences: { ...DEFAULT_ANALYSIS_PREFERENCES, mode: "balanced" },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onDisconnect: vi.fn(),
      }),
    );

    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Analysis");
    expect(html).toContain("Sources");
    expect(html).toContain("Account");
  });

  it("locks output-affecting controls while a run is active", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsScreen, {
        authenticated: true,
        preferences: { ...DEFAULT_ANALYSIS_PREFERENCES, mode: "balanced" },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onDisconnect: vi.fn(),
        analysisLocked: true,
      }),
    );

    expect(html).toContain("Finish or stop the current analysis");
    expect(html).toContain("disabled");
  });
});
