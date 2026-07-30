import type {
  AdditionalContextResult,
  AnalysisEvent,
  AnalysisMetadata,
  BiasResult,
  CompassResult,
  EvidenceSection,
  JournalistContextResult,
  SourceListResult,
} from "@perspectica/contracts";

export type LoadStatus = "waiting" | "loading" | "ready" | "empty" | "error";

export interface SectionState<T> {
  status: LoadStatus;
  data: T | null;
  error: string | null;
}

export interface ArticleMetadata {
  title: string;
  author: string | null;
  publication: string | null;
  publishedAt: string | null;
  contentType: "news" | "analysis" | "opinion" | "unknown";
}

export interface ReportState {
  phase: "idle" | "extracting" | "analyzing" | "complete" | "partial" | "error" | "cancelled";
  analysis: AnalysisMetadata | null;
  startedAt: string | null;
  metadata: ArticleMetadata | null;
  sourceList: SectionState<SourceListResult>;
  compass: SectionState<CompassResult>;
  bias: SectionState<BiasResult>;
  journalistContext: SectionState<JournalistContextResult>;
  supporting: SectionState<EvidenceSection>;
  contradicting: SectionState<EvidenceSection>;
  additionalContext: SectionState<AdditionalContextResult>;
  error: string | null;
}

const waiting = <T>(): SectionState<T> => ({
  status: "waiting",
  data: null,
  error: null,
});

export function createInitialReportState(): ReportState {
  return {
    phase: "idle",
    analysis: null,
    startedAt: null,
    metadata: null,
    sourceList: waiting(),
    compass: waiting(),
    bias: waiting(),
    journalistContext: waiting(),
    supporting: waiting(),
    contradicting: waiting(),
    additionalContext: waiting(),
    error: null,
  };
}

export function beginExtraction(): ReportState {
  return { ...createInitialReportState(), phase: "extracting" };
}

export function failReport(state: ReportState, message: string): ReportState {
  return { ...state, phase: "error", error: message };
}

export function cancelReport(state: ReportState): ReportState {
  return { ...state, phase: "cancelled", error: null };
}

function loaded<T extends { status: "ready" | "empty" }>(data: T): SectionState<T> {
  return { status: data.status, data, error: null };
}

function loading<T>(section: SectionState<T>): SectionState<T> {
  return { ...section, status: "loading", error: null };
}

function failed<T>(section: SectionState<T>, message: string): SectionState<T> {
  return { ...section, status: "error", error: message };
}

function failIncompleteSection<T>(
  section: SectionState<T>,
  message = "This section could not be completed. Try again.",
): SectionState<T> {
  return section.status === "ready" || section.status === "empty"
    ? section
    : failed(section, section.error ?? message);
}

function sourceUrlKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "fbclid" || key === "gclid" || key === "ref") {
        url.searchParams.delete(key);
      }
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().toLocaleLowerCase("en-US");
  } catch {
    return value.toLocaleLowerCase("en-US");
  }
}

function sourceUrls(section: EvidenceSection | AdditionalContextResult | null): Set<string> {
  return new Set(section?.sources.map((source) => sourceUrlKey(source.url)) ?? []);
}

function withoutSourceUrls<T extends EvidenceSection | AdditionalContextResult>(
  section: T,
  blockedUrls: ReadonlySet<string>,
  emptySummary: string,
): T {
  const sources = section.sources.filter((source) => !blockedUrls.has(sourceUrlKey(source.url)));
  if (sources.length === section.sources.length) return section;
  const sourceIds = new Set(sources.map((source) => source.id));
  const readerCopy = section.readerCopy
    ? {
        ...section.readerCopy,
        findings: section.readerCopy.findings
          .map((finding) => ({
            ...finding,
            citationIds: finding.citationIds.filter((id) => sourceIds.has(id)),
          }))
          .filter((finding) => finding.citationIds.length > 0),
      }
    : undefined;
  return {
    ...section,
    status: sources.length > 0 ? "ready" : "empty",
    summary: sources.length > 0 ? section.summary : emptySummary,
    sources,
    ...(sources.length > 0 && readerCopy ? { readerCopy } : { readerCopy: undefined }),
  } as T;
}

function pruneLoadedSection<T extends EvidenceSection | AdditionalContextResult>(
  section: SectionState<T>,
  blockedUrls: ReadonlySet<string>,
  emptySummary: string,
): SectionState<T> {
  return section.data
    ? loaded(withoutSourceUrls(section.data, blockedUrls, emptySummary))
    : section;
}

export function reduceAnalysisEvent(state: ReportState, event: AnalysisEvent): ReportState {
  if (state.analysis && state.analysis.analysisId !== event.analysisId) {
    return state;
  }

  switch (event.type) {
    case "analysis.started":
      return {
        ...state,
        phase: "analyzing",
        analysis: event.data,
        startedAt: event.data.startedAt,
        compass: loading(state.compass),
        bias: loading(state.bias),
        journalistContext: loading(state.journalistContext),
        supporting: loading(state.supporting),
        contradicting: loading(state.contradicting),
        additionalContext: loading(state.additionalContext),
      };
    case "metadata.ready":
      return { ...state, metadata: event.data };
    case "sourceList.ready":
      return { ...state, sourceList: loaded(event.data) };
    case "compass.provisional":
      return {
        ...state,
        compass: { status: "loading", data: event.data, error: null },
      };
    case "compass.ready":
      return { ...state, compass: { status: "ready", data: event.data, error: null } };
    case "bias.ready":
      return { ...state, bias: loaded(event.data) };
    case "journalistContext.ready":
      return { ...state, journalistContext: loaded(event.data) };
    case "supporting.ready": {
      const supporting = withoutSourceUrls(
        event.data,
        sourceUrls(state.contradicting.data),
        "No independently sourced supporting information was verified.",
      );
      return {
        ...state,
        supporting: loaded(supporting),
        additionalContext: pruneLoadedSection(
          state.additionalContext,
          sourceUrls(supporting),
          "No additional outside context was necessary to interpret the central claims.",
        ),
      };
    }
    case "contradicting.ready": {
      const contradictingUrls = sourceUrls(event.data);
      return {
        ...state,
        contradicting: loaded(event.data),
        supporting: pruneLoadedSection(
          state.supporting,
          contradictingUrls,
          "No independently sourced supporting information was verified.",
        ),
        additionalContext: pruneLoadedSection(
          state.additionalContext,
          contradictingUrls,
          "No additional outside context was necessary to interpret the central claims.",
        ),
      };
    }
    case "additionalContext.ready": {
      const blockedUrls = new Set([
        ...sourceUrls(state.supporting.data),
        ...sourceUrls(state.contradicting.data),
      ]);
      return {
        ...state,
        additionalContext: loaded(
          withoutSourceUrls(
            event.data,
            blockedUrls,
            "No additional outside context was necessary to interpret the central claims.",
          ),
        ),
      };
    }
    case "section.failed": {
      const message = event.data.message;
      switch (event.data.section) {
        case "compass":
          return { ...state, compass: failed(state.compass, message) };
        case "bias":
          return { ...state, bias: failed(state.bias, message) };
        case "journalist-context":
          return {
            ...state,
            journalistContext: failed(state.journalistContext, message),
          };
        case "supporting":
          return { ...state, supporting: failed(state.supporting, message) };
        case "contradicting":
          return { ...state, contradicting: failed(state.contradicting, message) };
        case "additional-context":
          return {
            ...state,
            additionalContext: failed(state.additionalContext, message),
          };
      }
    }
    case "analysis.completed":
      return event.data.status === "partial"
        ? {
            ...state,
            phase: "partial",
            compass: event.data.failedSections.includes("compass")
              ? failIncompleteSection(state.compass)
              : state.compass,
            bias: event.data.failedSections.includes("bias")
              ? failIncompleteSection(state.bias)
              : state.bias,
            journalistContext: event.data.failedSections.includes("journalist-context")
              ? failIncompleteSection(state.journalistContext)
              : state.journalistContext,
            supporting: event.data.failedSections.includes("supporting")
              ? failIncompleteSection(state.supporting)
              : state.supporting,
            contradicting: event.data.failedSections.includes("contradicting")
              ? failIncompleteSection(state.contradicting)
              : state.contradicting,
            additionalContext: event.data.failedSections.includes("additional-context")
              ? failIncompleteSection(state.additionalContext)
              : state.additionalContext,
          }
        : {
            ...state,
            phase: "complete",
          };
  }

  return state;
}
