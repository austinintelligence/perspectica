import type { ReaderCopy } from "@perspectica/contracts";

export function readerCopyFromAssertions(
  assertions: ReadonlyArray<{ id: string; statement: string; sourceId: string }>,
  lead: string,
): ReaderCopy | undefined {
  if (assertions.length === 0) return undefined;
  return {
    lead,
    findings: assertions.slice(0, 3).map((assertion) => ({
      id: `copy-${assertion.id}`,
      text: assertion.statement,
      citationIds: [assertion.sourceId],
      keySourceNote: null,
    })),
  };
}
