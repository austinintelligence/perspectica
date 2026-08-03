import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PartialReportNotice, ProvisionalCompassWarning } from "./App";

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
