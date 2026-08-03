import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  AdditionalContextResult,
  AnalysisPreferences,
  EvidenceSection as EvidenceSectionData,
  ExternalSource,
  JournalistContextResult,
  ReaderCopy,
  ReaderCitation,
  SourceListResult,
  ResearchDepth,
} from "@perspectica/contracts";
import type { ReportSection } from "@perspectica/contracts/report";
import { AnalysisProgress } from "./AnalysisProgress";
import { ArticleAccessScreen } from "./ArticleAccessScreen";
import { BrandHeader } from "./BrandHeader";
import { Compass } from "./Compass";
import { ChatGptConnectionScreen, usePerspecticaChatGpt } from "./ChatGptConnection";
import { TargetIcon } from "./Icons";
import { ProgressiveText } from "./ProgressiveText";
import { Section } from "./Section";
import type { SettingsPreferences } from "./SettingsScreen";
import { SearchSetupScreen } from "./SearchSetupScreen";
import { ResearchDepthControl } from "./DepthControl";
import { DEFAULT_ANALYSIS_PREFERENCES, recommendedInferenceForDepth } from "./preferences";
import {
  acceptedReaderCopy,
  buildFootnoteLedger,
  FootnoteMarker,
  InlineFootnotes,
  SectionFootnotes,
  canonicalCitationKey,
  type CitationTarget,
} from "./footnotes";
export {
  acceptedReaderCopy,
  buildFootnoteLedger,
  canonicalCitationKey,
  FootnoteMarker,
  InlineFootnotes,
  SectionFootnotes,
} from "./footnotes";
export type { CitationTarget, FootnoteEntry } from "./footnotes";
import {
  beginExtraction,
  beginTargetedRetry,
  cancelReport,
  failReport,
  isAnalysisActive,
} from "./report-state";
import type { ReportPhase } from "./report-state";
import { ReportStore } from "./report-store";
import type { ReportSectionKey } from "./report-store";
import {
  extensionMode,
  clearAnalysisLogs,
  getAnalysisLogs,
  getArticlePreview,
  getRuntimeState,
  isResumableJob,
  streamAnalysis,
  type AnalysisStreamStatus,
  testSearchProvider,
  updateExtensionPreferences,
} from "./api";
import { subscribeRuntimePush } from "../../src/runtime/client";
import type {
  ArticlePreview,
  ExtensionPreferences,
  RuntimeState,
  SearchProviderKind,
} from "../../src/runtime/messages";
import { PERSPECTICA_RUNTIME_PROTOCOL } from "../../src/runtime/messages";

const SettingsScreen = lazy(async () => {
  const module = await import("./SettingsScreen");
  return { default: module.SettingsScreen };
});

function RouteLoadingFallback() {
  return (
    <main className="runtime-state-screen atmosphere-page" aria-live="polite">
      <p className="eyebrow">Perspectica</p>
      <h1 data-route-heading tabIndex={-1}>
        Opening view…
      </h1>
      <div className="section-loading" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </main>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.inset = "0";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function compactByline(author: string, publication: string | null): string {
  let cleanedAuthor = author.replace(/^(?:by\s+)+/i, "").trim();
  if (
    publication &&
    cleanedAuthor.toLocaleLowerCase("en-US").endsWith(` ${publication.toLocaleLowerCase("en-US")}`)
  ) {
    cleanedAuthor = cleanedAuthor.slice(0, -(publication.length + 1)).trim();
  }

  const names = cleanedAuthor
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length <= 3) return cleanedAuthor;
  return `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SourceLink({
  source,
  footnote,
}: {
  source: ExternalSource;
  footnote?: { scope: string; number: number; citation: CitationTarget };
}) {
  const isSearchSummary = source.citationKind === "search-summary";
  return (
    <article className="source-result">
      <p>
        <ProgressiveText text={source.relationshipExplanation} />
      </p>
      <p className="source-citation">
        <span>Source:</span>{" "}
        <a href={source.url} target="_blank" rel="noreferrer">
          {source.title}
        </a>
        {footnote ? (
          <FootnoteMarker
            scope={footnote.scope}
            number={footnote.number}
            citation={footnote.citation}
          />
        ) : null}
        <small>
          {source.publication ? ` · ${source.publication}` : ""}
          {source.publishedAt ? ` · ${new Date(source.publishedAt).toLocaleDateString()}` : ""}
        </small>
        {isSearchSummary ? (
          <small className="search-summary-label">Web-search summary</small>
        ) : null}
      </p>
      {!isSearchSummary && source.excerpt ? (
        <blockquote>
          <ProgressiveText text={`“${source.excerpt}”`} />
        </blockquote>
      ) : null}
    </article>
  );
}

function ReaderCopyBody({
  copy,
  citations,
  labels,
  sectionId = "report",
}: {
  copy: ReaderCopy;
  citations: ReadonlyMap<string, CitationTarget>;
  labels?: ReadonlyMap<string, string>;
  sectionId?: string;
}) {
  const accepted = acceptedReaderCopy(copy, citations);
  if (!accepted) return null;
  const ledger = buildFootnoteLedger(
    accepted.findings.flatMap((finding) => finding.citationIds),
    citations,
  );
  return (
    <div className="reader-copy">
      <p>
        <ProgressiveText text={accepted.lead} />
      </p>
      {accepted.findings.map((finding) => {
        const findingLabels = [
          ...new Set(
            finding.citationIds.flatMap((id) => (labels?.has(id) ? [labels.get(id)!] : [])),
          ),
        ];
        return (
          <article className="reader-finding" key={finding.id}>
            {findingLabels.length > 0 ? (
              <small className="reader-finding-label">{findingLabels.join(" · ")}</small>
            ) : null}
            <p>
              <ProgressiveText text={finding.text} />
              <InlineFootnotes
                citationIds={finding.citationIds}
                citations={citations}
                scope={sectionId}
                numbers={ledger.numbers}
              />
            </p>
            {finding.keySourceNote ? (
              <small className="key-source-note">
                <ProgressiveText text={finding.keySourceNote} />
              </small>
            ) : null}
          </article>
        );
      })}
      <SectionFootnotes scope={sectionId} entries={ledger.entries} />
    </div>
  );
}

function evidenceCitationMap(sources: ExternalSource[]): Map<string, CitationTarget> {
  return new Map(
    sources.map((source) => [
      source.id,
      {
        id: source.id,
        title: source.title,
        publication: source.publication,
        url: source.url,
        publishedAt: source.publishedAt,
        citationKind: source.citationKind,
      },
    ]),
  );
}

function EvidenceBody({ result, sectionId }: { result: EvidenceSectionData; sectionId: string }) {
  const citations = evidenceCitationMap(result.sources);
  if (result.readerCopy && acceptedReaderCopy(result.readerCopy, citations)) {
    return <ReaderCopyBody copy={result.readerCopy} citations={citations} sectionId={sectionId} />;
  }
  const ledger = buildFootnoteLedger(
    result.sources.map((source) => source.id),
    citations,
  );
  return (
    <>
      <p>
        <ProgressiveText text={result.summary} />
      </p>
      {result.sources.map((source) => {
        const number = ledger.numbers.get(source.id);
        return (
          <SourceLink
            key={source.id}
            source={source}
            footnote={
              number ? { scope: sectionId, number, citation: citations.get(source.id)! } : undefined
            }
          />
        );
      })}
      <SectionFootnotes scope={sectionId} entries={ledger.entries} />
    </>
  );
}

function JournalistBody({ result }: { result: JournalistContextResult }) {
  const citations = new Map(
    result.findings.map((finding) => [
      finding.id,
      {
        id: finding.id,
        title: finding.sourceTitle,
        publication: finding.publication,
        url: finding.url,
        publishedAt: null,
        citationKind: finding.citationKind,
      },
    ]),
  );
  if (result.readerCopy && acceptedReaderCopy(result.readerCopy, citations)) {
    return (
      <ReaderCopyBody
        copy={result.readerCopy}
        sectionId="journalist-context"
        citations={citations}
      />
    );
  }
  const ledger = buildFootnoteLedger(
    result.findings.map((finding) => finding.id),
    citations,
  );
  return (
    <>
      <p>
        <ProgressiveText text={result.summary} />
      </p>
      {result.findings.map((finding) => (
        <article className="source-result" key={finding.id}>
          <p>
            <ProgressiveText text={finding.summary} />
          </p>
          <p className="source-citation">
            <span>Source:</span>{" "}
            <a href={finding.url} target="_blank" rel="noreferrer">
              {finding.sourceTitle}
            </a>
            {ledger.numbers.has(finding.id) ? (
              <FootnoteMarker
                scope="journalist-context"
                number={ledger.numbers.get(finding.id)!}
                citation={citations.get(finding.id)!}
              />
            ) : null}
            <small>{finding.publication ? ` · ${finding.publication}` : ""}</small>
            {finding.citationKind === "search-summary" ? (
              <small className="search-summary-label">Web-search summary</small>
            ) : null}
          </p>
          {finding.citationKind !== "search-summary" && finding.excerpt ? (
            <blockquote>
              <ProgressiveText text={`“${finding.excerpt}”`} />
            </blockquote>
          ) : null}
        </article>
      ))}
      <SectionFootnotes scope="journalist-context" entries={ledger.entries} />
    </>
  );
}

function AdditionalContextBody({ result }: { result: AdditionalContextResult }) {
  const citations = evidenceCitationMap(result.sources);
  if (result.readerCopy && acceptedReaderCopy(result.readerCopy, citations)) {
    return (
      <ReaderCopyBody
        copy={result.readerCopy}
        citations={citations}
        sectionId="additional-context"
      />
    );
  }
  const ledger = buildFootnoteLedger(
    result.sources.map((source) => source.id),
    citations,
  );
  return (
    <>
      <p>
        <ProgressiveText text={result.summary} />
      </p>
      {result.sources.map((source) => {
        const number = ledger.numbers.get(source.id);
        return (
          <SourceLink
            key={source.id}
            source={source}
            footnote={
              number
                ? { scope: "additional-context", number, citation: citations.get(source.id)! }
                : undefined
            }
          />
        );
      })}
      <SectionFootnotes scope="additional-context" entries={ledger.entries} />
    </>
  );
}

function SourceListBody({ result }: { result: SourceListResult }) {
  const seen = new Set<string>();
  const sources = result.sources.filter((source) => {
    const key = canonicalCitationKey(source.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (sources.length === 0) {
    return <p>No cited works were found in the article.</p>;
  }
  return (
    <ol className="original-sources">
      {sources.map((source) => (
        <li key={source.id}>
          <h3>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.label || new URL(source.url).hostname}
            </a>
          </h3>
        </li>
      ))}
    </ol>
  );
}

interface AnalyzeScreenProps {
  metadata: ArticleMetadataForPreview | null;
  previewStatus?: "loading" | "ready" | "error";
  previewError?: string | null;
  onAnalyze: () => void;
  onOpenSettings: () => void;
  menuItems?: ReadonlyArray<{ label: string; onSelect: () => void }>;
  researchDepth?: ResearchDepth;
  onResearchDepthChange?: (depth: ResearchDepth) => void;
}

type ArticleMetadataForPreview = {
  title: string;
  author: string | null;
  publication: string | null;
  publishedAt: string | null;
  contentType: string;
};

export function AnalyzeScreen({
  metadata,
  previewStatus = metadata ? "ready" : "loading",
  previewError = null,
  onAnalyze,
  onOpenSettings,
  menuItems,
  researchDepth = "balanced" as ResearchDepth,
  onResearchDepthChange,
}: AnalyzeScreenProps) {
  const publishedAt = formatDate(metadata?.publishedAt ?? null);
  return (
    <div className="app-shell atmosphere-page">
      <BrandHeader
        action="menu"
        actionLabel="Open Perspectica menu"
        onAction={onOpenSettings}
        menuItems={menuItems}
      />
      <main className="analyze-screen" aria-labelledby="analyze-title">
        <p className="eyebrow">Article preview</p>
        <h1 id="analyze-title" data-route-heading tabIndex={-1}>
          {metadata?.title ?? "Ready to read this article?"}
        </h1>
        {metadata ? (
          <p className="article-byline preview-byline">
            {metadata.publication ?? "Current article"}
            {metadata.author ? ` · By ${compactByline(metadata.author, metadata.publication)}` : ""}
            {publishedAt ? ` · ${publishedAt}` : ""}
          </p>
        ) : (
          <p className="analyze-lede">
            Perspectica previews the active article locally, then researches it only when you choose
            Analyze.
          </p>
        )}
        <div className="analyze-boundary" role="note">
          <strong>Research begins only when you select Analyze.</strong>
          <span>Your article stays local until then.</span>
        </div>
        <ResearchDepthControl
          depth={researchDepth}
          onChange={onResearchDepthChange}
          id="analyze-research-depth"
          compact
        />
        {previewError ? (
          <p id="analyze-preview-error" className="analyze-disabled-reason" role="alert">
            {previewError}
          </p>
        ) : null}
        <button
          type="button"
          className="chatgpt-action analyze-action"
          onClick={onAnalyze}
          disabled={previewStatus !== "ready"}
          aria-describedby={previewError ? "analyze-preview-error" : undefined}
        >
          {previewStatus === "loading" ? "Reading article…" : "Analyze article"}
        </button>
      </main>
    </div>
  );
}

export function DiagnosticsScreen({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [clearStatus, setClearStatus] = useState<"idle" | "clearing" | "cleared" | "error">("idle");
  const [manual, setManual] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const copy = async () => {
    if (
      !window.confirm(
        "Copy this run's support log? It may include article excerpts, research queries, and model output. Credentials and authentication values are redacted.",
      )
    ) {
      return;
    }
    setStatus("copying");
    try {
      const logs = await getAnalysisLogs();
      if (await copyText(logs.text)) {
        setStatus("copied");
      } else {
        setManual(logs.text);
        setStatus("error");
        requestAnimationFrame(() => {
          textRef.current?.focus();
          textRef.current?.select();
        });
      }
    } catch {
      setStatus("error");
    }
  };
  const clear = async () => {
    if (!window.confirm("Clear saved Perspectica diagnostics from this device?")) return;
    setClearStatus("clearing");
    try {
      await clearAnalysisLogs();
      setManual(null);
      setClearStatus("cleared");
    } catch {
      setClearStatus("error");
    }
  };
  return (
    <div className="connection-shell atmosphere-page diagnostics-screen">
      <BrandHeader action="close" actionLabel="Back to settings" onAction={onBack} />
      <main className="settings-main" aria-labelledby="diagnostics-title">
        <p className="eyebrow">Support</p>
        <h1 id="diagnostics-title" data-route-heading tabIndex={-1}>
          Diagnostics
        </h1>
        <p className="connection-lede">
          Copy a sanitized activity log when you need help. It may include article excerpts,
          searches, and model output; credentials and authentication values are redacted.
        </p>
        <div className="diagnostics-actions">
          <button type="button" className="chatgpt-action" onClick={() => void copy()}>
            {status === "copying"
              ? "Preparing logs…"
              : status === "copied"
                ? "Logs copied"
                : "Copy logs"}
          </button>
          <button
            type="button"
            className="clear-logs-button"
            onClick={() => void clear()}
            disabled={clearStatus === "clearing"}
          >
            {clearStatus === "clearing"
              ? "Clearing…"
              : clearStatus === "cleared"
                ? "Diagnostics cleared"
                : clearStatus === "error"
                  ? "Could not clear"
                  : "Clear diagnostics"}
          </button>
          <p className="settings-saved" role={status === "error" ? "alert" : "status"}>
            {status === "error" ? "Automatic copy was blocked; use the selected log below." : ""}
          </p>
          {manual ? (
            <textarea
              ref={textRef}
              className="manual-log-textarea"
              readOnly
              value={manual}
              aria-label="Perspectica sanitized diagnostics log"
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

export function AboutScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="connection-shell atmosphere-page">
      <BrandHeader action="close" actionLabel="Back to settings" onAction={onBack} />
      <main className="runtime-state-screen" aria-labelledby="about-title">
        <p className="eyebrow">Perspectica</p>
        <h1 id="about-title" data-route-heading tabIndex={-1}>
          Read with context.
        </h1>
        <p>An editorial lens for understanding how reporting is framed, supported, and situated.</p>
        <section className="about-team" aria-labelledby="about-team-title">
          <h2 id="about-team-title">Built by</h2>
          <ul>
            <li>Austin Morgan</li>
            <li>Lathik Ram C.</li>
            <li>Mathew Estis</li>
            <li>Jordan Allen</li>
          </ul>
        </section>
        <p className="settings-saved">Research stays bounded to the article you choose.</p>
      </main>
    </div>
  );
}

interface AnalysisReportProps {
  preferences: AnalysisPreferences;
  onOpenSettings: () => void;
  menuItems?: ReadonlyArray<{ label: string; onSelect: () => void }>;
  autoStart?: boolean;
  screen?: "controller" | "running" | "report";
  onPhaseChange?: (phase: ReportPhase) => void;
  runRequest?: number;
}

export function PartialReportNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="page-notice report-partial-notice" role="status">
      <strong>Most of the report is ready.</strong>
      <p>
        One or more research sections could not finish. Available results are shown below, and
        incomplete sections are clearly marked.
      </p>
      <button type="button" onClick={onRetry}>
        Retry incomplete sections
      </button>
    </div>
  );
}

export function ProvisionalCompassWarning() {
  return (
    <p className="compass-result-warning" role="alert">
      Political-spectrum research did not finish. This preliminary placement may change if you retry
      the report.
    </p>
  );
}

function useReportSection<K extends ReportSectionKey>(store: ReportStore, section: K) {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeSection(section, listener),
    [section, store],
  );
  const getSnapshot = useCallback(() => store.getSectionSnapshot(section), [section, store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const ConnectedCompass = memo(function ConnectedCompass({
  store,
  onRetry,
}: {
  store: ReportStore;
  onRetry?: () => void;
}) {
  const section = useReportSection(store, "compass");
  return section.data ? (
    <>
      <Compass result={section.data} />
      {section.status === "error" ? (
        <>
          <ProvisionalCompassWarning />
          {onRetry ? (
            <button className="section-retry compass-retry" type="button" onClick={onRetry}>
              Retry Political Spectrum
            </button>
          ) : null}
        </>
      ) : null}
    </>
  ) : (
    <>
      <div className="compass-placeholder">
        <TargetIcon />
        <span>
          <small>Political Spectrum</small>
          <strong>{section.status === "error" ? "Unavailable" : "Finding placement…"}</strong>
        </span>
      </div>
      {section.status === "error" && onRetry ? (
        <button className="section-retry compass-retry" type="button" onClick={onRetry}>
          Retry Political Spectrum
        </button>
      ) : null}
    </>
  );
});

const ConnectedBias = memo(function ConnectedBias({
  store,
  onRetry,
}: {
  store: ReportStore;
  onRetry?: () => void;
}) {
  const section = useReportSection(store, "bias");
  const data = section.data;
  const citations = new Map(
    (data?.citations ?? []).map((citation: ReaderCitation) => [citation.id, citation]),
  );
  return (
    <Section id="bias" title="Bias" status={section.status} error={section.error} onRetry={onRetry}>
      {data ? (
        data.readerCopy && acceptedReaderCopy(data.readerCopy, citations) ? (
          <ReaderCopyBody
            copy={data.readerCopy}
            sectionId="bias"
            labels={new Map(data.findings.map((finding) => [finding.id, finding.displayName]))}
            citations={citations}
          />
        ) : (
          <>
            <p>
              <ProgressiveText text={data.summary} />
            </p>
            {data.findings.map((finding) => (
              <div className="finding" key={finding.id}>
                <h3>{finding.displayName}</h3>
                <blockquote>
                  <ProgressiveText text={`“${finding.excerpt}”`} />
                </blockquote>
                <p>
                  <ProgressiveText text={finding.explanation} />
                </p>
              </div>
            ))}
          </>
        )
      ) : null}
    </Section>
  );
});

const ConnectedJournalistContext = memo(function ConnectedJournalistContext({
  store,
  onRetry,
}: {
  store: ReportStore;
  onRetry?: () => void;
}) {
  const section = useReportSection(store, "journalistContext");
  return (
    <Section
      id="journalist-context"
      title="Journalist Context"
      status={section.status}
      error={section.error}
      onRetry={onRetry}
    >
      {section.data ? <JournalistBody result={section.data} /> : null}
    </Section>
  );
});

const ConnectedEvidence = memo(function ConnectedEvidence({
  store,
  section: sectionKey,
  title,
  id,
  onRetry,
}: {
  store: ReportStore;
  section: "supporting" | "contradicting";
  title: string;
  id: string;
  onRetry?: () => void;
}) {
  const section = useReportSection(store, sectionKey);
  return (
    <Section id={id} title={title} status={section.status} error={section.error} onRetry={onRetry}>
      {section.data ? <EvidenceBody result={section.data} sectionId={id} /> : null}
    </Section>
  );
});

const ConnectedAdditionalContext = memo(function ConnectedAdditionalContext({
  store,
  onRetry,
}: {
  store: ReportStore;
  onRetry?: () => void;
}) {
  const section = useReportSection(store, "additionalContext");
  return (
    <Section
      id="additional-context"
      title="Additional Context"
      status={section.status}
      error={section.error}
      onRetry={onRetry}
    >
      {section.data ? <AdditionalContextBody result={section.data} /> : null}
    </Section>
  );
});

const ConnectedSourceList = memo(function ConnectedSourceList({
  store,
  onRetry,
}: {
  store: ReportStore;
  onRetry?: () => void;
}) {
  const section = useReportSection(store, "sourceList");
  return (
    <Section
      id="sources"
      title="Works Cited"
      status={section.status}
      error={section.error}
      onRetry={onRetry}
    >
      {section.data ? <SourceListBody result={section.data} /> : null}
    </Section>
  );
});

function AnalysisReport({
  preferences,
  onOpenSettings,
  menuItems,
  autoStart = false,
  screen = "report",
  onPhaseChange,
  runRequest = 0,
}: AnalysisReportProps) {
  const reportStoreRef = useRef<ReportStore | null>(null);
  reportStoreRef.current ??= new ReportStore();
  const reportStore = reportStoreRef.current;
  const state = useSyncExternalStore(
    reportStore.subscribe,
    reportStore.getSnapshot,
    reportStore.getSnapshot,
  );
  const [streamStatus, setStreamStatus] = useState<AnalysisStreamStatus>("connected");
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const effectStartedRef = useRef(false);
  const handledRunRequestRef = useRef(-1);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    onPhaseChange?.(state.phase);
  }, [onPhaseChange, state.phase]);

  const analyze = useCallback(
    async (forceNew = false, retrySections?: readonly ReportSection[]) => {
      const runId = ++runRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (retrySections?.length) {
        reportStore.set((current) => beginTargetedRetry(current, retrySections));
      } else {
        reportStore.reset(beginExtraction());
      }
      setStreamStatus("connected");

      try {
        await streamAnalysis(
          (event) => {
            if (runRef.current !== runId) return;
            reportStore.apply(event);
          },
          controller.signal,
          preferencesRef.current,
          setStreamStatus,
          { forceNew, retrySections },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (runRef.current === runId) {
          reportStore.set((current) =>
            failReport(
              current,
              error instanceof Error ? error.message : "The article could not be analyzed.",
            ),
          );
        }
      }
    },
    [reportStore],
  );

  const retryIncompleteSections = useCallback(() => {
    const sections: ReportSection[] = state.failedSections.length
      ? state.failedSections
      : ["supporting", "contradicting", "additional-context"];
    void analyze(false, sections);
  }, [analyze, state.failedSections]);

  const retrySection = useCallback(
    (section: ReportSection) => {
      void analyze(false, [section]);
    },
    [analyze],
  );

  const cancelAnalysis = useCallback(() => {
    if (!isAnalysisActive(state.phase)) return;
    abortRef.current?.abort();
    reportStore.set((current) => cancelReport(current));
  }, [reportStore, state.phase]);

  useEffect(() => {
    // React StrictMode replays effects in development. The run id and abort
    // guard above keep a replay from creating a second active stream.
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    if (autoStart && (!effectStartedRef.current || handledRunRequestRef.current !== runRequest)) {
      effectStartedRef.current = true;
      handledRunRequestRef.current = runRequest;
      void analyze();
    }
    return () => {
      // Defer cancellation by one turn so StrictMode's replay can cancel the
      // cleanup without aborting the one real analysis stream.
      cleanupTimerRef.current = setTimeout(() => {
        abortRef.current?.abort();
        cleanupTimerRef.current = null;
      }, 0);
    };
  }, [analyze, autoStart, runRequest]);

  const metadata = state.metadata;
  const publishedAt = formatDate(metadata?.publishedAt ?? null);

  if (screen === "controller") return null;

  if (screen === "running") {
    return (
      <div className="app-shell atmosphere-page running-shell">
        <BrandHeader
          action="menu"
          actionLabel="Open Perspectica menu"
          onAction={onOpenSettings}
          menuItems={menuItems}
        />
        <main className="running-main" aria-labelledby="running-title">
          <p className="eyebrow">Research in progress</p>
          <h1 id="running-title" data-route-heading tabIndex={-1}>
            Building your report
          </h1>
          {metadata?.title ? <p className="running-article-title">{metadata.title}</p> : null}
          <p className="running-lede">
            Perspectica is checking the article, its framing, and independent context.
          </p>
          <AnalysisProgress state={state} onCancel={cancelAnalysis} />
          {streamStatus === "reconnecting" ? (
            <p className="stream-reconnect" role="status">
              Reconnecting to the analysis…
            </p>
          ) : null}
          {state.error ? (
            <div className="page-error" role="alert">
              <strong>Research needs attention.</strong>
              <p>{state.error}</p>
              <button type="button" onClick={() => void analyze(true)}>
                Retry research
              </button>
            </div>
          ) : null}
          {state.phase === "cancelled" ? (
            <div className="page-notice" role="status">
              <strong>Research stopped.</strong>
              <p>Your article preview is still available. Start a fresh report when ready.</p>
              <button type="button" onClick={() => void analyze(true)}>
                Retry research
              </button>
            </div>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell atmosphere-page">
      <BrandHeader
        action="menu"
        actionLabel="Open preferences"
        onAction={onOpenSettings}
        menuItems={menuItems}
      />
      <header className="article-header">
        {metadata ? (
          <div className="article-intro">
            <p className="article-eyebrow">
              {metadata.publication ?? "Current article"} · {metadata.contentType}
            </p>
            <h1 data-route-heading tabIndex={-1}>
              {metadata.title}
            </h1>
            {metadata.author || publishedAt ? (
              <p className="article-byline" title={metadata.author ?? undefined}>
                {metadata.author
                  ? `By ${compactByline(metadata.author, metadata.publication)}`
                  : null}
                {metadata.author && publishedAt ? <span aria-hidden="true">·</span> : null}
                {publishedAt}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="article-intro intro-loading">
            <p className="article-eyebrow">Current article</p>
            <h1 data-route-heading tabIndex={-1}>
              Reading the page…
            </h1>
          </div>
        )}
      </header>

      <AnalysisProgress state={state} onCancel={cancelAnalysis} />
      {streamStatus === "reconnecting" && isAnalysisActive(state.phase) ? (
        <p className="stream-reconnect">Reconnecting to the analysis…</p>
      ) : null}

      <main className="report-main">
        {state.error ? (
          <div className="page-error" role="alert">
            <strong>Perspectica could not finish this article.</strong>
            <p>{state.error}</p>
            <button type="button" onClick={() => void analyze(true)}>
              Try again
            </button>
          </div>
        ) : null}

        {state.phase === "cancelled" ? (
          <div className="page-notice" role="status">
            <strong>Analysis stopped.</strong>
            <p>You can run the report again whenever you are ready.</p>
            <button type="button" onClick={() => void analyze(true)}>
              Analyze again
            </button>
          </div>
        ) : null}

        {state.phase === "partial" ? (
          <PartialReportNotice onRetry={retryIncompleteSections} />
        ) : null}

        <ConnectedCompass store={reportStore} onRetry={() => retrySection("compass")} />
        <ConnectedBias store={reportStore} onRetry={() => retrySection("bias")} />
        <ConnectedJournalistContext
          store={reportStore}
          onRetry={() => retrySection("journalist-context")}
        />
        <ConnectedEvidence
          store={reportStore}
          section="supporting"
          id="supporting"
          title="Supporting Information"
          onRetry={() => retrySection("supporting")}
        />
        <ConnectedEvidence
          store={reportStore}
          section="contradicting"
          id="contradicting"
          title="Contradicting Information"
          onRetry={() => retrySection("contradicting")}
        />
        <ConnectedAdditionalContext
          store={reportStore}
          onRetry={() => retrySection("additional-context")}
        />
        <ConnectedSourceList store={reportStore} onRetry={() => retrySection("works-cited")} />

        {/* Legacy section markup removed in favor of connected sections.
                {state.compass.status === "error" ? "Unavailable" : "Finding placement…"}
                      <ProgressiveText text={`“${finding.excerpt}”`} />
        */}
      </main>
    </div>
  );
}

function ChatGptApp() {
  const connection = usePerspecticaChatGpt();
  type Screen = "analyze" | "running" | "report" | "settings" | "diagnostics" | "about";
  const [screen, setScreen] = useState<Screen>("analyze");
  const returnScreenRef = useRef<Screen>("analyze");
  const [researchDepth, setResearchDepth] = useState<ResearchDepth>("balanced" as ResearchDepth);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [providerReady, setProviderReady] = useState(false);
  const [articleAccess, setArticleAccess] = useState<"loading" | "granted" | "missing">("loading");
  const [articlePreview, setArticlePreview] = useState<ArticlePreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<"loading" | "ready" | "error">("loading");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [runRequest, setRunRequest] = useState(0);
  const [analysisPhase, setAnalysisPhase] = useState<ReportPhase>("idle");
  const previousScreenRef = useRef<Screen>("analyze");
  const reportScrollTopRef = useRef(0);

  const openSettings = useCallback(() => {
    returnScreenRef.current = screen;
    setScreen("settings");
  }, [screen]);
  const closeSettings = useCallback(() => setScreen(returnScreenRef.current), []);

  useEffect(() => {
    const previous = previousScreenRef.current;
    const modalRoute = screen === "settings" || screen === "diagnostics" || screen === "about";
    const wasModalRoute =
      previous === "settings" || previous === "diagnostics" || previous === "about";
    if (modalRoute && !wasModalRoute) {
      reportScrollTopRef.current = window.scrollY;
      window.scrollTo({ top: 0, behavior: "auto" });
    } else if (!modalRoute && wasModalRoute) {
      requestAnimationFrame(() =>
        window.scrollTo({ top: reportScrollTopRef.current, behavior: "auto" }),
      );
    } else if (screen !== previous) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    previousScreenRef.current = screen;
    requestAnimationFrame(() => {
      const heading =
        document.querySelector<HTMLElement>("[data-route-heading]") ??
        document.querySelector<HTMLElement>(".page-transition main h1, .page-transition header h1");
      heading?.focus({ preventScroll: true });
    });
  }, [articleAccess, providerReady, runtimeError, screen, Boolean(runtime)]);

  useEffect(() => {
    let active = true;
    setRuntimeError(null);
    void getRuntimeState()
      .then((state) => {
        if (!active) return;
        if (state.runtimeProtocol !== PERSPECTICA_RUNTIME_PROTOCOL) {
          // Load-unpacked builds can refresh the side-panel document while an
          // older service worker remains alive. Reload the entire extension
          // before any analysis starts instead of mixing runtime generations.
          chrome.runtime.reload();
          return;
        }
        setRuntime(state);
        setResearchDepth((state.preferences.depth ?? "balanced") as ResearchDepth);
        setProviderReady(state.preferences.searchProvider !== "exa" || state.hasExaKey);
        const activeJob = state.activeJob;
        if (activeJob && isResumableJob(activeJob)) {
          setScreen(
            activeJob.status === "complete" || activeJob.status === "partial"
              ? "report"
              : "running",
          );
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setRuntimeError(
          cause instanceof Error
            ? cause.message
            : "Perspectica could not start its local extension runtime.",
        );
      });
    const unsubscribe = subscribeRuntimePush((message) => {
      if (message.type === "auth.changed") {
        setRuntime((current) => (current ? { ...current, auth: message.auth } : current));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [runtimeAttempt]);

  useEffect(() => {
    let active = true;
    void chrome.permissions
      .contains({ origins: ["<all_urls>"] })
      .then((granted) => {
        if (active) setArticleAccess(granted ? "granted" : "missing");
      })
      .catch(() => {
        if (active) setArticleAccess("missing");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      !connection.isAuthenticated ||
      !runtime ||
      !providerReady ||
      articleAccess !== "granted" ||
      screen !== "analyze"
    ) {
      return;
    }
    let active = true;
    setPreviewStatus("loading");
    setPreviewError(null);
    void getArticlePreview().then(
      (preview) => {
        if (!active) return;
        setArticlePreview(preview);
        setPreviewStatus("ready");
      },
      (cause: unknown) => {
        if (!active) return;
        setArticlePreview(null);
        setPreviewStatus("error");
        setPreviewError(
          cause instanceof Error
            ? cause.message
            : "Open a news article in this window, then try again.",
        );
      },
    );
    return () => {
      active = false;
    };
  }, [articleAccess, connection.isAuthenticated, providerReady, runtime, screen]);

  const updatePreferences = async (next: SettingsPreferences): Promise<void> => {
    if (!runtime) throw new Error("Perspectica settings are still loading.");
    const previous = runtime;
    const updated: ExtensionPreferences = {
      ...runtime.preferences,
      ...next,
    };
    setRuntime({ ...runtime, preferences: updated });
    try {
      const saved = await updateExtensionPreferences(updated);
      setRuntime((current) => (current ? { ...current, preferences: saved } : current));
    } catch (error) {
      setRuntime(previous);
      throw error;
    }
  };

  const updateSearchProvider = async (provider: SearchProviderKind) => {
    if (!runtime) throw new Error("Perspectica settings are still loading.");
    const previous = runtime;
    const test = await testSearchProvider(provider);
    if (!test.available) throw new Error(`${provider} search is not available.`);
    const updated = { ...runtime.preferences, searchProvider: provider };
    setRuntime({ ...runtime, preferences: updated });
    setProviderReady(true);
    try {
      const saved = await updateExtensionPreferences(updated);
      setRuntime((current) => (current ? { ...current, preferences: saved } : current));
    } catch (error) {
      setRuntime(previous);
      setProviderReady(previous.preferences.searchProvider !== "exa" || previous.hasExaKey);
      throw error;
    }
  };

  const updateResearchDepth = async (depth: ResearchDepth) => {
    const previousDepth = researchDepth;
    setResearchDepth(depth);
    if (!runtime) return;
    try {
      await updatePreferences({
        ...runtime.preferences,
        ...recommendedInferenceForDepth(depth),
        depth,
        mode: depth,
      });
    } catch (error) {
      setResearchDepth(previousDepth);
      throw error;
    }
  };

  const menuItems = [
    { label: "Settings", onSelect: openSettings },
    {
      label: "Diagnostics",
      onSelect: () => {
        returnScreenRef.current = screen;
        setScreen("diagnostics");
      },
    },
    {
      label: "About",
      onSelect: () => {
        returnScreenRef.current = screen;
        setScreen("about");
      },
    },
  ] as const;
  const auxiliaryScreen = screen === "settings" || screen === "diagnostics" || screen === "about";

  let page: ReactNode;
  if (runtimeError && !auxiliaryScreen) {
    page = (
      <div className="connection-shell atmosphere-page">
        <BrandHeader action="menu" actionLabel="Open preferences" onAction={openSettings} />
        <main className="runtime-state-screen" role="alert">
          <p className="eyebrow">Extension runtime</p>
          <h1 data-route-heading tabIndex={-1}>
            Perspectica needs a moment.
          </h1>
          <p>{runtimeError}</p>
          <button
            type="button"
            className="chatgpt-action"
            onClick={() => {
              setRuntime(null);
              setRuntimeAttempt((attempt) => attempt + 1);
            }}
          >
            Try again
          </button>
        </main>
      </div>
    );
  } else if (
    connection.isAuthenticated &&
    !auxiliaryScreen &&
    (!runtime || articleAccess === "loading")
  ) {
    page = (
      <div className="connection-shell atmosphere-page">
        <BrandHeader action="menu" actionLabel="Open preferences" onAction={openSettings} />
        <main className="runtime-state-screen" aria-live="polite">
          <p className="eyebrow">Preparing Perspectica</p>
          <h1 data-route-heading tabIndex={-1}>
            Restoring your local session…
          </h1>
          <div className="section-loading" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </main>
      </div>
    );
  } else if (
    connection.isAuthenticated &&
    !auxiliaryScreen &&
    runtime &&
    articleAccess === "missing"
  ) {
    page = (
      <ArticleAccessScreen
        onReady={() => setArticleAccess("granted")}
        onOpenSettings={openSettings}
      />
    );
  } else if (connection.isAuthenticated && runtime && (providerReady || auxiliaryScreen)) {
    if (screen === "settings") {
      page = (
        <SettingsScreen
          authenticated={connection.isAuthenticated}
          preferences={runtime.preferences}
          onChange={updatePreferences}
          onClose={closeSettings}
          onDisconnect={connection.logout}
          availableModels={connection.models}
          searchProvider={runtime.preferences.searchProvider}
          hasExaKey={runtime.hasExaKey}
          onSearchProviderChange={updateSearchProvider}
          researchDepth={researchDepth}
          onResearchDepthChange={updateResearchDepth}
          analysisLocked={isAnalysisActive(analysisPhase)}
          onOpenDiagnostics={() => setScreen("diagnostics")}
          onOpenAbout={() => setScreen("about")}
          onExaKeySaved={() => {
            setRuntime((current) => (current ? { ...current, hasExaKey: true } : current));
            setProviderReady(true);
          }}
          onExaKeyRemoved={() => {
            setRuntime((current) => (current ? { ...current, hasExaKey: false } : current));
            if (runtime.preferences.searchProvider === "exa") setProviderReady(false);
          }}
        />
      );
    } else if (screen === "diagnostics") {
      page = <DiagnosticsScreen onBack={() => setScreen("settings")} />;
    } else if (screen === "about") {
      page = <AboutScreen onBack={() => setScreen("settings")} />;
    } else if (screen === "analyze") {
      page = (
        <AnalyzeScreen
          metadata={articlePreview}
          previewStatus={previewStatus}
          previewError={previewError}
          onAnalyze={() => {
            if (previewStatus !== "ready") return;
            setRunRequest((request) => request + 1);
            setScreen("running");
          }}
          onOpenSettings={openSettings}
          menuItems={menuItems}
          researchDepth={researchDepth}
          onResearchDepthChange={updateResearchDepth}
        />
      );
    } else {
      page = null;
    }
  } else if (connection.isAuthenticated && runtime && !auxiliaryScreen) {
    page = (
      <SearchSetupScreen
        preferences={runtime.preferences}
        onChange={async (preferences) => {
          await updateExtensionPreferences(preferences);
          setRuntime({
            ...runtime,
            preferences,
            hasExaKey: preferences.searchProvider === "exa" || runtime.hasExaKey,
          });
        }}
        onReady={() => {
          setProviderReady(true);
          setScreen("analyze");
        }}
        onOpenSettings={openSettings}
      />
    );
  } else if (screen === "settings") {
    page = (
      <SettingsScreen
        authenticated={false}
        preferences={{ ...DEFAULT_ANALYSIS_PREFERENCES, mode: "balanced" }}
        onChange={async () => undefined}
        onClose={closeSettings}
        onDisconnect={connection.logout}
        researchDepth={researchDepth}
        onResearchDepthChange={async () => undefined}
      />
    );
  } else if (screen === "diagnostics") {
    page = <DiagnosticsScreen onBack={() => setScreen("settings")} />;
  } else if (screen === "about") {
    page = <AboutScreen onBack={() => setScreen("settings")} />;
  } else {
    page = <ChatGptConnectionScreen connection={connection} onOpenSettings={openSettings} />;
  }

  return (
    <>
      {runtime && providerReady && connection.isAuthenticated ? (
        <AnalysisReport
          preferences={runtime.preferences}
          onOpenSettings={openSettings}
          menuItems={menuItems}
          autoStart={screen === "running" || screen === "report"}
          screen={screen === "running" || screen === "report" ? screen : "controller"}
          runRequest={runRequest}
          onPhaseChange={(phase) => {
            setAnalysisPhase(phase);
            if (isAnalysisActive(phase) && (screen === "analyze" || screen === "report")) {
              setScreen("running");
            } else if ((phase === "complete" || phase === "partial") && screen === "running") {
              setScreen("report");
            } else if (phase === "cancelled" && (screen === "running" || screen === "report")) {
              setScreen("analyze");
            }
          }}
        />
      ) : null}
      <div className="page-transition">
        <Suspense fallback={<RouteLoadingFallback />}>{page}</Suspense>
      </div>
    </>
  );
}

function DemoApp() {
  type DemoScreen = "report" | "settings";
  const [screen, setScreen] = useState<DemoScreen>("report");
  const returnScreenRef = useRef<DemoScreen>("report");
  const [preferences, setPreferences] = useState<SettingsPreferences>({
    ...DEFAULT_ANALYSIS_PREFERENCES,
    mode: "balanced",
  });

  return (
    <>
      <AnalysisReport
        preferences={preferences}
        onOpenSettings={() => {
          returnScreenRef.current = "report";
          setScreen("settings");
        }}
        screen={screen === "settings" ? "controller" : "report"}
      />
      {screen === "settings" ? (
        <Suspense fallback={<RouteLoadingFallback />}>
          <SettingsScreen
            authenticated={false}
            preferences={preferences}
            onChange={setPreferences}
            onClose={() => setScreen(returnScreenRef.current)}
            onDisconnect={async () => undefined}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export function App() {
  return extensionMode === "demo" ? <DemoApp /> : <ChatGptApp />;
}
