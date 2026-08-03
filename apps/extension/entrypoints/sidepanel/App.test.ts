import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnalyzeScreen, PartialReportNotice, ProvisionalCompassWarning } from "./App";

describe("partial report feedback", () => {
  it("clearly identifies a partial report and offers a bounded retry", () => {
    const html = renderToStaticMarkup(createElement(PartialReportNotice, { onRetry: vi.fn() }));

    expect(html).toContain('role="status"');
    expect(html).toContain("Most of the report is ready.");
    expect(html).toContain("incomplete sections are clearly marked");
    expect(html).toContain("Retry incomplete sections");
  });

  it("labels a preserved provisional compass as potentially stale", () => {
    const html = renderToStaticMarkup(createElement(ProvisionalCompassWarning));

    expect(html).toContain('role="alert"');
    expect(html).toContain("preliminary placement may change");
  });
});

describe("explicit article analysis", () => {
  it("keeps Analyze disabled until the local article preview is ready", () => {
    const html = renderToStaticMarkup(
      createElement(AnalyzeScreen, {
        metadata: null,
        previewStatus: "loading",
        onAnalyze: vi.fn(),
        onOpenSettings: vi.fn(),
      }),
    );

    expect(html).toContain("Article preview");
    expect(html).toContain("Reading article…");
    expect(html).toContain("disabled");
    expect(html).toContain("Research begins only when you select Analyze.");
  });

  it("renders extracted article metadata and the selected research depth", () => {
    const html = renderToStaticMarkup(
      createElement(AnalyzeScreen, {
        metadata: {
          title: "A verified local preview",
          author: "Riley Reporter",
          publication: "Example News",
          publishedAt: "2026-08-03T12:00:00.000Z",
          contentType: "news",
        },
        previewStatus: "ready",
        researchDepth: "deep",
        onAnalyze: vi.fn(),
        onOpenSettings: vi.fn(),
      }),
    );

    expect(html).toContain("A verified local preview");
    expect(html).toContain("Example News · By Riley Reporter");
    expect(html).toContain('aria-valuetext="Deep"');
    expect(html).toContain("Analyze article");
  });
});
