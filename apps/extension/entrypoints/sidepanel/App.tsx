import {
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
import { SettingsScreen } from "./SettingsScreen";
import type { SettingsPreferences } from "./SettingsScreen";
import { SearchSetupScreen } from "./SearchSetupScreen";
import { DEFAULT_ANALYSIS_PREFERENCES } from "./preferences";
import {
  beginExtraction,
  beginTargetedRetry,
  cancelReport,
  failReport,
  isAnalysisActive,
} from "./report-state";
import { ReportStore } from "./report-store";
import {
  extensionMode,
  clearAnalysisLogs,
  getAnalysisLogs,
  getRuntimeState,
  streamAnalysis,
  type AnalysisStreamStatus,
  testSearchProvider,
  updateExtensionPreferences,
} from "./api";
import { subscribeRuntimePush } from "../../src/runtime/client";
import type {
  ExtensionPreferences,
  RuntimeState,
  SearchProviderKind,
} from "../../src/runtime/messages";
import { PERSPECTICA_RUNTIME_PROTOCOL } from "../../src/runtime/messages";

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

export function SourceLink({ source }: { source: ExternalSource }) {
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

interface CitationTarget {
  id: string;
  title: string;
  publication: string;
  url: string;
  citationKind?: "source-excerpt" | "search-summary";
}

function InlineCitations({
  citationIds,
  citations,
}: {
  citationIds: string[];
  citations: ReadonlyMap<string, CitationTarget>;
}) {
  const accepted = citationIds.flatMap((id) => {
    const citation = citations.get(id);
    return citation ? [citation] : [];
  });
  if (accepted.length === 0) return null;
  return (
    <span className="inline-citations" aria-label="Sources">
      {accepted.map((citation) => (
        <span className="inline-citation" key={citation.id}>
          <a href={citation.url} target="_blank" rel="noreferrer">
            {citation.publication || citation.title}
          </a>
          {citation.citationKind === "search-summary" ? (
            <small className="search-summary-label">Web-search summary</small>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function ReaderCopyBody({
  copy,
  citations,
  labels,
}: {
  copy: ReaderCopy;
  citations: ReadonlyMap<string, CitationTarget>;
  labels?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="reader-copy">
      <p>
        <ProgressiveText text={copy.lead} />
      </p>
      {copy.findings.map((finding) => {
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
              <InlineCitations citationIds={finding.citationIds} citations={citations} />
            </p>
            {finding.keySourceNote ? (
              <small className="key-source-note">
                <ProgressiveText text={finding.keySourceNote} />
              </small>
            ) : null}
          </article>
        );
      })}
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
        citationKind: source.citationKind,
      },
    ]),
  );
}

function EvidenceBody({ result }: { result: EvidenceSectionData }) {
  if (result.readerCopy) {
    return (
      <ReaderCopyBody copy={result.readerCopy} citations={evidenceCitationMap(result.sources)} />
    );
  }
  return (
    <>
      <p>
        <ProgressiveText text={result.summary} />
      </p>
      {result.sources.map((source) => (
        <SourceLink key={source.id} source={source} />
      ))}
    </>
  );
}

function JournalistBody({ result }: { result: JournalistContextResult }) {
  if (result.readerCopy) {
    return (
      <ReaderCopyBody
        copy={result.readerCopy}
        citations={
          new Map(
            result.findings.map((finding) => [
              finding.id,
              {
                id: finding.id,
                title: finding.sourceTitle,
                publication: finding.publication,
                url: finding.url,
                citationKind: finding.citationKind,
              },
            ]),
          )
        }
      />
    );
  }
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
    </>
  );
}

function AdditionalContextBody({ result }: { result: AdditionalContextResult }) {
  if (result.readerCopy) {
    return (
      <ReaderCopyBody copy={result.readerCopy} citations={evidenceCitationMap(result.sources)} />
    );
  }
  return (
    <>
      <p>
        <ProgressiveText text={result.summary} />
      </p>
      {result.sources.map((source) => (
        <SourceLink key={source.id} source={source} />
      ))}
    </>
  );
}

function SourceListBody({ result }: { result: SourceListResult }) {
  if (result.sources.length === 0) {
    return <p>No cited works were found in the article.</p>;
  }
  return (
    <ol className="original-sources">
      {result.sources.map((source) => (
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

interface AnalysisReportProps {
  preferences: AnalysisPreferences;
  onOpenSettings: () => void;
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

function AnalysisReport({ preferences, onOpenSettings }: AnalysisReportProps) {
  const reportStoreRef = useRef<ReportStore | null>(null);
  reportStoreRef.current ??= new ReportStore();
  const reportStore = reportStoreRef.current;
  const state = useSyncExternalStore(
    reportStore.subscribe,
    reportStore.getSnapshot,
    reportStore.getSnapshot,
  );
  const [streamStatus, setStreamStatus] = useState<AnalysisStreamStatus>("connected");
  const [logCopyStatus, setLogCopyStatus] = useState<"idle" | "copying" | "copied" | "error">(
    "idle",
  );
  const [logClearStatus, setLogClearStatus] = useState<"idle" | "clearing" | "cleared" | "error">(
    "idle",
  );
  const [logExportText, setLogExportText] = useState<string | null>(null);
  const [logExportError, setLogExportError] = useState<string | null>(null);
  const logExportRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const effectStartedRef = useRef(false);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

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
    if (!effectStartedRef.current) {
      effectStartedRef.current = true;
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
  }, [analyze]);

  const metadata = state.metadata;
  const publishedAt = formatDate(metadata?.publishedAt ?? null);
  const copyLogs = useCallback(async () => {
    setLogCopyStatus("copying");
    setLogExportError(null);
    try {
      const exported = await getAnalysisLogs();
      if (await copyText(exported.text)) {
        setLogExportText(null);
        setLogCopyStatus("copied");
        return;
      }
      setLogExportText(exported.text);
      setLogCopyStatus("error");
      requestAnimationFrame(() => {
        logExportRef.current?.focus();
        logExportRef.current?.select();
      });
    } catch (error) {
      setLogExportError(
        error instanceof Error ? error.message : "Perspectica could not prepare the logs.",
      );
      setLogCopyStatus("error");
    }
  }, []);

  const clearLogs = useCallback(async () => {
    if (state.phase === "idle" || !window.confirm("Clear saved telemetry for this analysis?")) {
      return;
    }
    setLogClearStatus("clearing");
    try {
      await clearAnalysisLogs();
      setLogClearStatus("cleared");
    } catch {
      setLogClearStatus("error");
    }
  }, [state.phase]);

  return (
    <div className="app-shell atmosphere-page">
      <BrandHeader action="menu" actionLabel="Open preferences" onAction={onOpenSettings} />
      <header className="article-header">
        {metadata ? (
          <div className="article-intro">
            <p className="article-eyebrow">
              {metadata.publication ?? "Current article"} · {metadata.contentType}
            </p>
            <h1>{metadata.title}</h1>
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
            <h1>Reading the page…</h1>
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

        {state.compass.data ? (
          <>
            <Compass result={state.compass.data} />
            {state.compass.status === "error" ? <ProvisionalCompassWarning /> : null}
          </>
        ) : (
          <div className="compass-placeholder">
            <TargetIcon />
            <span>
              <small>Political Spectrum</small>
              <strong>
                {state.compass.status === "error" ? "Unavailable" : "Finding placement…"}
              </strong>
            </span>
          </div>
        )}

        <Section id="bias" title="Bias" status={state.bias.status} error={state.bias.error}>
          {state.bias.data ? (
            state.bias.data.readerCopy ? (
              <ReaderCopyBody
                copy={state.bias.data.readerCopy}
                labels={
                  new Map(
                    state.bias.data.findings.map((finding) => [finding.id, finding.displayName]),
                  )
                }
                citations={
                  new Map(
                    (state.bias.data.citations ?? []).map((citation: ReaderCitation) => [
                      citation.id,
                      citation,
                    ]),
                  )
                }
              />
            ) : (
              <>
                <p>
                  <ProgressiveText text={state.bias.data.summary} />
                </p>
                {state.bias.data.findings.map((finding) => (
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

        <Section
          id="journalist-context"
          title="Journalist Context"
          status={state.journalistContext.status}
          error={state.journalistContext.error}
        >
          {state.journalistContext.data ? (
            <JournalistBody result={state.journalistContext.data} />
          ) : null}
        </Section>

        <Section
          id="supporting"
          title="Supporting Information"
          status={state.supporting.status}
          error={state.supporting.error}
        >
          {state.supporting.data ? <EvidenceBody result={state.supporting.data} /> : null}
        </Section>

        <Section
          id="contradicting"
          title="Contradicting Information"
          status={state.contradicting.status}
          error={state.contradicting.error}
        >
          {state.contradicting.data ? <EvidenceBody result={state.contradicting.data} /> : null}
        </Section>

        <Section
          id="additional-context"
          title="Additional Context"
          status={state.additionalContext.status}
          error={state.additionalContext.error}
        >
          {state.additionalContext.data ? (
            <AdditionalContextBody result={state.additionalContext.data} />
          ) : null}
        </Section>

        <Section
          id="sources"
          title="Works Cited"
          status={state.sourceList.status}
          error={state.sourceList.error}
        >
          {state.sourceList.data ? <SourceListBody result={state.sourceList.data} /> : null}
        </Section>

        <footer className="telemetry-footer">
          <button
            type="button"
            className="copy-logs-button"
            onClick={() => void copyLogs()}
            disabled={logCopyStatus === "copying" || state.phase === "idle"}
          >
            {logCopyStatus === "copying"
              ? "Preparing logs…"
              : logCopyStatus === "copied"
                ? "Logs copied"
                : logCopyStatus === "error"
                  ? logExportText
                    ? "Logs ready below"
                    : "Try copying logs again"
                  : "Copy logs"}
          </button>
          <button
            type="button"
            className="clear-logs-button"
            onClick={() => void clearLogs()}
            disabled={logClearStatus === "clearing" || state.phase === "idle"}
          >
            {logClearStatus === "clearing"
              ? "Clearing…"
              : logClearStatus === "cleared"
                ? "Telemetry cleared"
                : logClearStatus === "error"
                  ? "Could not clear"
                  : "Clear logs"}
          </button>
          {logExportText ? (
            <div className="manual-log-export">
              <p>
                Automatic copy was blocked. The full sanitized log is selected below—press Command+C
                to copy it.
              </p>
              <textarea
                ref={logExportRef}
                readOnly
                value={logExportText}
                aria-label="Perspectica analysis telemetry"
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          ) : null}
          {logExportError ? (
            <p className="telemetry-error" role="alert">
              {logExportError}
            </p>
          ) : null}
          <span className="sr-only">
            {logCopyStatus === "copied" ? "Full sanitized telemetry copied." : ""}
          </span>
        </footer>
      </main>
    </div>
  );
}

function ChatGptApp() {
  const connection = usePerspecticaChatGpt();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [providerReady, setProviderReady] = useState(false);
  const [articleAccess, setArticleAccess] = useState<"loading" | "granted" | "missing">("loading");

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
        setProviderReady(state.preferences.searchProvider === "chatgpt" || state.hasExaKey);
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

  const updatePreferences = (next: SettingsPreferences) => {
    if (!runtime) return;
    const updated: ExtensionPreferences = {
      ...runtime.preferences,
      ...next,
    };
    setRuntime({ ...runtime, preferences: updated });
    void updateExtensionPreferences(updated);
  };

  const updateSearchProvider = async (provider: SearchProviderKind) => {
    if (!runtime) throw new Error("Perspectica settings are still loading.");
    const test = await testSearchProvider(provider);
    if (!test.available) throw new Error(`${provider} search is not available.`);
    const updated = { ...runtime.preferences, searchProvider: provider };
    setRuntime({ ...runtime, preferences: updated });
    setProviderReady(true);
    await updateExtensionPreferences(updated);
  };

  let page: ReactNode;
  if (runtimeError) {
    page = (
      <div className="connection-shell atmosphere-page">
        <BrandHeader
          action="menu"
          actionLabel="Open preferences"
          onAction={() => setSettingsOpen(true)}
        />
        <main className="runtime-state-screen" role="alert">
          <p className="eyebrow">Extension runtime</p>
          <h1>Perspectica needs a moment.</h1>
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
  } else if (connection.isAuthenticated && (!runtime || articleAccess === "loading")) {
    page = (
      <div className="connection-shell atmosphere-page">
        <BrandHeader
          action="menu"
          actionLabel="Open preferences"
          onAction={() => setSettingsOpen(true)}
        />
        <main className="runtime-state-screen" aria-live="polite">
          <p className="eyebrow">Preparing Perspectica</p>
          <h1>Restoring your local session…</h1>
          <div className="section-loading" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </main>
      </div>
    );
  } else if (connection.isAuthenticated && runtime && articleAccess === "missing") {
    page = (
      <ArticleAccessScreen
        onReady={() => setArticleAccess("granted")}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  } else if (connection.isAuthenticated && runtime && providerReady) {
    page = (
      <AnalysisReport
        preferences={runtime.preferences}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  } else if (connection.isAuthenticated && runtime) {
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
        onReady={() => setProviderReady(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  } else {
    page = (
      <ChatGptConnectionScreen
        connection={connection}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  }

  return (
    <>
      <div className="page-transition">{page}</div>
      {settingsOpen ? (
        <SettingsScreen
          authenticated={connection.isAuthenticated}
          preferences={
            runtime?.preferences ?? { ...DEFAULT_ANALYSIS_PREFERENCES, mode: "balanced" }
          }
          onChange={updatePreferences}
          onClose={() => setSettingsOpen(false)}
          onDisconnect={connection.logout}
          availableModels={connection.models}
          searchProvider={runtime?.preferences.searchProvider}
          hasExaKey={runtime?.hasExaKey}
          onSearchProviderChange={updateSearchProvider}
          onExaKeySaved={() => {
            if (!runtime) return;
            setRuntime({ ...runtime, hasExaKey: true });
            setProviderReady(true);
          }}
          onExaKeyRemoved={() => {
            if (!runtime) return;
            setRuntime({ ...runtime, hasExaKey: false });
            if (runtime.preferences.searchProvider === "exa") setProviderReady(false);
          }}
        />
      ) : null}
    </>
  );
}

function DemoApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState<SettingsPreferences>({
    ...DEFAULT_ANALYSIS_PREFERENCES,
    mode: "balanced",
  });

  return (
    <>
      <AnalysisReport preferences={preferences} onOpenSettings={() => setSettingsOpen(true)} />
      {settingsOpen ? (
        <SettingsScreen
          authenticated={false}
          preferences={preferences}
          onChange={setPreferences}
          onClose={() => setSettingsOpen(false)}
          onDisconnect={async () => undefined}
        />
      ) : null}
    </>
  );
}

export function App() {
  return extensionMode === "demo" ? <DemoApp /> : <ChatGptApp />;
}
