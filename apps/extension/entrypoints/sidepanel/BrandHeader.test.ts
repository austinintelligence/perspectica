import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandHeader, shouldCompactMasthead } from "./BrandHeader";

describe("shouldCompactMasthead", () => {
  it("keeps the full masthead near the article header and compacts it while reading", () => {
    expect(shouldCompactMasthead(96)).toBe(false);
    expect(shouldCompactMasthead(97)).toBe(true);
  });
});

it("associates the menu trigger with a stable menu id", () => {
  const html = renderToStaticMarkup(
    createElement(BrandHeader, {
      action: "menu",
      actionLabel: "Open menu",
      onAction: () => undefined,
      menuItems: [{ label: "Settings", onSelect: () => undefined }],
    }),
  );

  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toMatch(/aria-controls="masthead-menu-[^"]+"/);
  expect(html).toContain('aria-expanded="false"');
});
