import type { ReaderCopy } from "@perspectica/contracts";
import { describe, expect, it } from "vitest";
import { reconcileReaderCopy } from "./reader-copy";

const generatedCopy: ReaderCopy = {
  lead: "The bridge agreement and investment figures both need qualification.",
  findings: [
    {
      id: "reader-bridge",
      text: "The bridge agreement uses a narrower definition of net revenue.",
      citationIds: ["bridge-source"],
      keySourceNote: "The source reproduces the agreement text.",
    },
    {
      id: "reader-investment",
      text: "Announced investment commitments are not the same as completed investment.",
      citationIds: ["investment-source"],
      keySourceNote: null,
    },
  ],
};

describe("reconcileReaderCopy", () => {
  it("removes prose tied to rejected sources and replaces the now-stale lead", () => {
    const result = reconcileReaderCopy(generatedCopy, new Set(["investment-source"]), {
      fallbackLead: "Outside evidence adds an important limit to the article’s investment claim.",
    });

    expect(result).toEqual({
      lead: "Outside evidence adds an important limit to the article’s investment claim.",
      findings: [
        {
          id: "reader-investment",
          text: "Announced investment commitments are not the same as completed investment.",
          citationIds: ["investment-source"],
          keySourceNote: null,
        },
      ],
    });
  });

  it("builds concise source-backed copy when every generated citation is rejected", () => {
    const result = reconcileReaderCopy(generatedCopy, new Set(["accepted-source"]), {
      fallbackLead: "Independent evidence supports an important claim in the article.",
      fallbackFindings: [
        {
          id: "reader-fallback",
          text: "The official record confirms the agreement.",
          citationId: "accepted-source",
          keySourceNote: "This is the signed agreement.",
        },
      ],
    });

    expect(result).toMatchObject({
      lead: "Independent evidence supports an important claim in the article.",
      findings: [
        {
          text: "The official record confirms the agreement.",
          citationIds: ["accepted-source"],
          keySourceNote: "This is the signed agreement.",
        },
      ],
    });
  });
});
