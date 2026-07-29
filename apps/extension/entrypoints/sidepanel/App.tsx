import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
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
import { AnalysisProgress } from "./AnalysisProgress";
import { BrandHeader } from "./BrandHeader";
import { Compass } from "./Compass";
import { ChatGptConnectionScreen, usePerspecticaChatGpt } from "./ChatGptConnection";
import { TargetIcon } from "./Icons";
import { ProgressiveText } from "./ProgressiveText";
import { Section } from "./Section";
import { SettingsScreen } from "./SettingsScreen";
import {
  DEFAULT_ANALYSIS_PREFERENCES,
  readAnalysisPreferences,
  saveAnalysisPreferences,
} from "./preferences";
import {
  beginExtraction,
  createInitialReportState,
  failReport,
  reduceAnalysisEvent,
  type ReportState,
} from "./report-state";
import { extensionMode, extractActiveArticle, streamAnalysis } from "./api";

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

function SourceLink({ source }: { source: ExternalSource }) {
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
      </p>
      <blockquote>
        <ProgressiveText text={`“${source.excerpt}”`} />
      </blockquote>
    </article>
  );
}

interface CitationTarget {
  id: string;
  title: string;
  publication: string;
  url: string;
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
        <a key={citation.id} href={citation.url} target="_blank" rel="noreferrer">
          {citation.publication || citation.title}
        </a>
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
          </p>
          <blockquote>
            <ProgressiveText text={`“${finding.excerpt}”`} />
          </blockquote>
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

function AnalysisReport({ preferences, onOpenSettings }: AnalysisReportProps) {
  const [state, setState] = useState<ReportState>(createInitialReportState);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const effectStartedRef = useRef(false);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  const analyze = useCallback(async () => {
    const runId = ++runRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState(beginExtraction());

    try {
      const article = await extractActiveArticle();
      await streamAnalysis(
        article,
        (event) => {
          if (runRef.current !== runId) return;
          setState((current) => reduceAnalysisEvent(current, event));
        },
        controller.signal,
        preferencesRef.current,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (runRef.current === runId) {
        setState((current) =>
          failReport(
            current,
            error instanceof Error ? error.message : "The article could not be analyzed.",
          ),
        );
      }
    }
  }, []);

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

      <AnalysisProgress state={state} />

      <main className="report-main">
        {state.error ? (
          <div className="page-error" role="alert">
            <strong>Perspectica could not finish this article.</strong>
            <p>{state.error}</p>
            <button type="button" onClick={() => void analyze()}>
              Try again
            </button>
          </div>
        ) : null}

        {state.compass.data ? (
          <Compass result={state.compass.data} />
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
      </main>
    </div>
  );
}

function ChatGptApp() {
  const connection = usePerspecticaChatGpt();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState(readAnalysisPreferences);

  const updatePreferences = (next: AnalysisPreferences) => {
    setPreferences(next);
    saveAnalysisPreferences(next);
  };

  return (
    <>
      {connection.isAuthenticated ? (
        <AnalysisReport preferences={preferences} onOpenSettings={() => setSettingsOpen(true)} />
      ) : (
        <ChatGptConnectionScreen
          connection={connection}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      <AnimatePresence>
        {settingsOpen ? (
          <SettingsScreen
            authenticated={connection.isAuthenticated}
            preferences={preferences}
            onChange={updatePreferences}
            onClose={() => setSettingsOpen(false)}
            onDisconnect={connection.logout}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

function DemoApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState(DEFAULT_ANALYSIS_PREFERENCES);

  return (
    <>
      <AnalysisReport preferences={preferences} onOpenSettings={() => setSettingsOpen(true)} />
      <AnimatePresence>
        {settingsOpen ? (
          <SettingsScreen
            authenticated={false}
            preferences={preferences}
            onChange={setPreferences}
            onClose={() => setSettingsOpen(false)}
            onDisconnect={async () => undefined}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

export function App() {
  return extensionMode === "demo" ? <DemoApp /> : <ChatGptApp />;
}
