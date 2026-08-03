import type { AnalysisPlan } from "@perspectica/contracts/report";
import type {
  EvidenceAssertion,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  SourceRecord,
} from "@perspectica/contracts/evidence";

export function buildEvidenceGraph(
  plan: AnalysisPlan,
  sources: readonly SourceRecord[],
  assertions: readonly EvidenceAssertion[],
): { nodes: EvidenceGraphNode[]; edges: EvidenceGraphEdge[] } {
  const nodes: EvidenceGraphNode[] = [
    ...plan.claims.map((claim) => ({ id: claim.id, kind: "claim" as const, label: claim.text })),
    ...sources.map((source) => ({ id: source.id, kind: "source" as const, label: source.title })),
    ...assertions.map((assertion) => ({
      id: assertion.id,
      kind: "assertion" as const,
      label: assertion.statement,
    })),
  ];
  const edges: EvidenceGraphEdge[] = [];
  for (const assertion of assertions) {
    edges.push({ from: assertion.id, to: assertion.sourceId, relation: "grounded-by" });
    if (assertion.claimId)
      edges.push({ from: assertion.claimId, to: assertion.id, relation: assertion.relationship });
  }
  return { nodes, edges };
}
