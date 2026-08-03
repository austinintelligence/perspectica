import { describe, expect, it } from "vitest";
import { acceptedReaderCopy, buildFootnoteLedger, type CitationTarget } from "./footnotes";

const citations = new Map<string, CitationTarget>([
  ["a", { id: "a", title: "A", publication: "Example", url: "https://example.com/story/" }],
  ["b", { id: "b", title: "B", publication: "Example", url: "https://example.com/story#details" }],
]);

describe("canonical footnote ledger", () => {
  it("numbers first use and deduplicates equivalent URLs", () => {
    const ledger = buildFootnoteLedger(["b", "a"], citations);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.numbers.get("a")).toBe(1);
    expect(ledger.numbers.get("b")).toBe(1);
  });

  it("drops reader findings without accepted citations", () => {
    const copy = {
      lead: "lead",
      findings: [{ id: "stale", text: "stale", citationIds: ["missing"], keySourceNote: null }],
    };
    expect(acceptedReaderCopy(copy, citations)).toBeNull();
  });
});
