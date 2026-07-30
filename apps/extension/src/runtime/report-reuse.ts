import { normalizeCanonicalUrl, type ArticleDocument } from "@perspectica/contracts";
import type { AnalysisJob, ExtensionPreferences } from "./messages";

const REUSABLE_JOB_STATUSES = new Set<AnalysisJob["status"]>([
  "queued",
  "extracting",
  "analyzing",
  "complete",
  "partial",
]);

/** Stable identity for every preference that can materially change a report. */
export function createAnalysisConfigFingerprint(
  preferences: Pick<ExtensionPreferences, "model" | "reasoningEffort" | "searchProvider">,
): string {
  return [
    "analysis-config-v1",
    preferences.model,
    preferences.reasoningEffort,
    preferences.searchProvider,
  ].join(":");
}

/** Detect navigation using the browser's actual URL, not page canonical metadata. */
export function tabUrlChanged(beforeUrl: string, afterUrl: string): boolean {
  const before = normalizeCanonicalUrl(beforeUrl);
  const after = normalizeCanonicalUrl(afterUrl);
  return !before || !after || before !== after;
}

/** Background-authoritative identity for safely reusing a rendered report. */
export function canReuseAnalysisJob(
  job: AnalysisJob | null | undefined,
  article: Pick<ArticleDocument, "canonicalUrl" | "fingerprint">,
  tabId: number,
  analysisConfigFingerprint: string,
  forceNew = false,
): boolean {
  if (forceNew || !job || !REUSABLE_JOB_STATUSES.has(job.status) || job.tabId !== tabId) {
    return false;
  }
  const jobUrl = normalizeCanonicalUrl(job.tabUrl);
  const articleUrl = normalizeCanonicalUrl(article.canonicalUrl);
  return Boolean(
    jobUrl &&
    articleUrl &&
    jobUrl === articleUrl &&
    job.articleFingerprint &&
    job.articleFingerprint === article.fingerprint &&
    job.analysisConfigFingerprint === analysisConfigFingerprint,
  );
}
