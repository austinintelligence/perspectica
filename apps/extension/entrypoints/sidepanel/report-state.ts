import type { PipelineEvent, PipelinePhase } from "@perspectica/contracts/events";
import type {
  AdditionalContextResult,
  AnalysisMetadata,
  BiasResult,
  CompassResult,
  EvidenceSection,
  JournalistContextResult,
  SourceListResult,
} from "@perspectica/contracts";
import type { AnalysisPlan, ReportSection } from "@perspectica/contracts/report";

export type LoadStatus = "waiting" | "loading" | "ready" | "empty" | "error";
export type ReportPhase =
  | "idle"
  | "index"
  | "plan"
  | "retrieval"
  | "perspective"
  | "composition"
  | "complete"
  | "partial"
  | "error"
  | "cancelled";

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

export interface IndexedArticleSummary {
  fingerprint: string;
  paragraphCount: number;
  sentenceCount: number;
  claimSeedCount: number;
}

export interface ResearchProgress {
  candidateCount: number;
  completedMissions: number;
  totalMissions: number;
  acceptedSources: number;
  acceptedAssertions: number;
  sufficiency: string;
}

export interface ReportState {
  phase: ReportPhase;
  pipelinePhase: PipelinePhase | null;
  phaseMessage: string | null;
  analysis: AnalysisMetadata | null;
  startedAt: string | null;
  metadata: ArticleMetadata | null;
  indexed: IndexedArticleSummary | null;
  plan: AnalysisPlan | null;
  research: ResearchProgress | null;
  ledger: { sourceCount: number; assertionCount: number };
  failedSections: ReportSection[];
  sourceList: SectionState<SourceListResult>;
  compass: SectionState<CompassResult>;
  bias: SectionState<BiasResult>;
  journalistContext: SectionState<JournalistContextResult>;
  supporting: SectionState<EvidenceSection>;
  contradicting: SectionState<EvidenceSection>;
  additionalContext: SectionState<AdditionalContextResult>;
  error: string | null;
}

const waiting = <T>(): SectionState<T> => ({ status: "waiting", data: null, error: null });

export function createInitialReportState(): ReportState {
  return {
    phase: "idle",
    pipelinePhase: null,
    phaseMessage: null,
    analysis: null,
    startedAt: null,
    metadata: null,
    indexed: null,
    plan: null,
    research: null,
    ledger: { sourceCount: 0, assertionCount: 0 },
    failedSections: [],
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
  return { ...createInitialReportState(), phase: "index", phaseMessage: "Reading the article." };
}

export function beginTargetedRetry(
  state: ReportState,
  sections: readonly ReportSection[],
): ReportState {
  let next: ReportState = {
    ...state,
    phase: "retrieval",
    pipelinePhase: "retrieving",
    phaseMessage: "Retrying incomplete research lanes.",
    failedSections: state.failedSections.filter((section) => !sections.includes(section)),
    error: null,
  };
  for (const section of sections) {
    switch (section) {
      case "compass":
        next = { ...next, compass: loading(next.compass) };
        break;
      case "bias":
        next = { ...next, bias: loading(next.bias) };
        break;
      case "journalist-context":
        next = { ...next, journalistContext: loading(next.journalistContext) };
        break;
      case "supporting":
        next = { ...next, supporting: loading(next.supporting) };
        break;
      case "contradicting":
        next = { ...next, contradicting: loading(next.contradicting) };
        break;
      case "additional-context":
        next = { ...next, additionalContext: loading(next.additionalContext) };
        break;
      case "works-cited":
        next = { ...next, sourceList: loading(next.sourceList) };
        break;
    }
  }
  return next;
}

export function isAnalysisActive(phase: ReportPhase): boolean {
  return ["index", "plan", "retrieval", "perspective", "composition"].includes(phase);
}

export function failReport(state: ReportState, message: string): ReportState {
  return {
    ...state,
    phase: "error",
    pipelinePhase: "failed",
    phaseMessage: message,
    error: message,
  };
}

export function cancelReport(state: ReportState): ReportState {
  return { ...state, phase: "cancelled", pipelinePhase: "cancelled", error: null };
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

function phaseForPipeline(phase: PipelinePhase): ReportPhase {
  switch (phase) {
    case "indexed":
      return "index";
    case "planning":
      return "plan";
    case "retrieving":
      return "retrieval";
    case "adjudicating":
      return "perspective";
    case "composing":
      return "composition";
    case "complete":
      return "complete";
    case "partial":
      return "partial";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
  }
}

export function reducePipelineEvent(state: ReportState, event: PipelineEvent): ReportState {
  if (state.analysis && state.analysis.analysisId !== event.analysisId) return state;

  switch (event.type) {
    case "analysis.started":
      return {
        ...state,
        phase: "index",
        pipelinePhase: null,
        phaseMessage: "Reading the article.",
        analysis: event.data,
        startedAt: event.data.startedAt,
        sourceList: loading(state.sourceList),
        compass: loading(state.compass),
        bias: loading(state.bias),
        journalistContext: loading(state.journalistContext),
        supporting: loading(state.supporting),
        contradicting: loading(state.contradicting),
        additionalContext: loading(state.additionalContext),
        error: null,
      };
    case "article.indexed":
      return {
        ...state,
        phase: "index",
        indexed: {
          fingerprint: event.data.fingerprint,
          paragraphCount: event.data.paragraphCount,
          sentenceCount: event.data.sentenceCount,
          claimSeedCount: event.data.claimSeedCount,
        },
      };
    case "phase.changed":
      return {
        ...state,
        phase: phaseForPipeline(event.data.phase),
        pipelinePhase: event.data.phase,
        phaseMessage: event.data.message,
        error: event.data.phase === "failed" ? event.data.message : state.error,
      };
    case "metadata.ready":
      return { ...state, metadata: event.data };
    case "sourceList.ready":
    case "worksCited.ready":
      return { ...state, sourceList: loaded(event.data) };
    case "lens.ready":
      return {
        ...state,
        plan: event.data.plan,
        compass: event.data.provisionalCompass
          ? { status: "loading", data: event.data.provisionalCompass, error: null }
          : loading(state.compass),
        bias: loaded(event.data.provisionalBias),
      };
    case "research.progress":
      return { ...state, research: event.data };
    case "ledger.updated":
      return {
        ...state,
        ledger: { sourceCount: event.data.sourceCount, assertionCount: event.data.assertionCount },
      };
    case "perspective.ready":
      return {
        ...state,
        compass: event.data.compass
          ? { status: "ready", data: event.data.compass, error: null }
          : { status: "empty", data: null, error: null },
        journalistContext: loaded(event.data.journalistContext),
      };
    case "section.ready":
      switch (event.data.section) {
        case "bias":
          return { ...state, bias: loaded(event.data.data) };
        case "journalist-context":
          return { ...state, journalistContext: loaded(event.data.data) };
        case "supporting":
          return { ...state, supporting: loaded(event.data.data) };
        case "contradicting":
          return { ...state, contradicting: loaded(event.data.data) };
        case "additional-context":
          return { ...state, additionalContext: loaded(event.data.data) };
      }
      return state;
    case "analysis.completed":
      return {
        ...state,
        phase: event.data.status === "partial" ? "partial" : "complete",
        pipelinePhase: event.data.status,
        phaseMessage:
          event.data.status === "partial"
            ? "Report complete with limited external evidence."
            : "Report complete.",
        failedSections: event.data.failedSections,
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
      };
    case "analysis.failed":
      return {
        ...state,
        phase: "error",
        pipelinePhase: "failed",
        phaseMessage: event.data.message,
        error: event.data.message,
      };
    case "analysis.cancelled":
      return {
        ...state,
        phase: "cancelled",
        pipelinePhase: "cancelled",
        phaseMessage: event.data.message,
        error: null,
      };
  }
}
