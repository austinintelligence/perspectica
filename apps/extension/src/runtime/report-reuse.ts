import { normalizeCanonicalUrl, type ArticleDocument } from "@perspectica/contracts";
import {
  ARTICLE_INDEX_VERSION,
  INTELLIGENCE_PIPELINE_VERSION,
  INTELLIGENCE_PROMPT_VERSION,
} from "@perspectica/contracts/limits";
import type { AnalysisMode } from "@perspectica/contracts/preferences";
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
  preferences: Pick<ExtensionPreferences, "model" | "reasoningEffort" | "searchProvider"> &
    Partial<Pick<ExtensionPreferences, "mode" | "depth">>,
  providerScope = "provider-scope:unknown",
): string {
  return [
    "analysis-config-v2",
    ARTICLE_INDEX_VERSION,
    INTELLIGENCE_PIPELINE_VERSION,
    INTELLIGENCE_PROMPT_VERSION,
    preferences.model,
    preferences.reasoningEffort,
    canonicalMode(preferences.mode),
    preferences.depth ?? "balanced",
    preferences.searchProvider,
    providerScope,
  ].join(":");
}

function canonicalMode(mode: ExtensionPreferences["mode"] | "fast" | undefined): AnalysisMode {
  return mode === "fast" ? "quick" : (mode ?? "balanced");
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
  currentTabUrl = article.canonicalUrl,
): boolean {
  if (forceNew || !job || !REUSABLE_JOB_STATUSES.has(job.status) || job.tabId !== tabId) {
    return false;
  }
  const jobUrl = normalizeCanonicalUrl(job.tabUrl);
  const articleUrl = normalizeCanonicalUrl(currentTabUrl);
  return Boolean(
    jobUrl &&
    articleUrl &&
    jobUrl === articleUrl &&
    job.articleFingerprint &&
    job.articleFingerprint === article.fingerprint &&
    job.analysisConfigFingerprint === analysisConfigFingerprint,
  );
}
