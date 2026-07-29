import { ReaderCopySchema, type ReaderCopy } from "@perspectica/contracts";

export interface ReaderCopyFallbackFinding {
  id: string;
  text: string;
  citationId: string;
  keySourceNote?: string | null;
}

interface ReconcileReaderCopyOptions {
  fallbackLead: string;
  fallbackFindings?: ReaderCopyFallbackFinding[];
}

function compact(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trim()}…`;
}

/**
 * Keeps reader-facing prose aligned with the evidence that survived server
 * validation. A removed source must also remove the sentence that cited it.
 */
export function reconcileReaderCopy(
  copy: ReaderCopy,
  acceptedIds: ReadonlySet<string>,
  options: ReconcileReaderCopyOptions,
): ReaderCopy {
  const seen = new Set<string>();
  const generatedFindings = copy.findings
    .map((finding) => ({
      ...finding,
      text: compact(finding.text, 560),
      citationIds: [...new Set(finding.citationIds)]
        .filter((id) => acceptedIds.has(id))
        .slice(0, 4),
      keySourceNote: finding.keySourceNote ? compact(finding.keySourceNote, 260) : null,
    }))
    .filter((finding) => finding.citationIds.length > 0)
    .filter((finding) => {
      const key = finding.text.toLocaleLowerCase("en-US");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);

  const usedFallback = generatedFindings.length === 0;
  const fallbackFindings = (options.fallbackFindings ?? [])
    .filter((finding) => acceptedIds.has(finding.citationId))
    .map((finding) => ({
      id: finding.id,
      text: compact(finding.text, 560),
      citationIds: [finding.citationId],
      keySourceNote: finding.keySourceNote ? compact(finding.keySourceNote, 260) : null,
    }))
    .filter((finding) => {
      const key = finding.text.toLocaleLowerCase("en-US");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);
  const findings = usedFallback ? fallbackFindings : generatedFindings;
  const lostGeneratedEvidence = generatedFindings.length < copy.findings.length;

  return ReaderCopySchema.parse({
    lead:
      usedFallback || lostGeneratedEvidence
        ? compact(options.fallbackLead, 420)
        : compact(copy.lead, 420),
    findings,
  });
}
