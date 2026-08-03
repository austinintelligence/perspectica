import { useEffect, useState } from "react";
import type { ReportPhase, ReportState } from "./report-state";
import { isAnalysisActive } from "./report-state";
import { formatElapsedMs } from "./streaming";

export type ReaderProgressPhase = "reading" | "planning" | "researching" | "synthesizing";

const readerPhases: ReadonlyArray<{
  phase: ReaderProgressPhase;
  label: string;
  waitingDetail: string;
}> = [
  { phase: "reading", label: "Reading article", waitingDetail: "Waiting to read the page" },
  {
    phase: "planning",
    label: "Planning research",
    waitingDetail: "Waiting for the article review",
  },
  {
    phase: "researching",
    label: "Checking sources",
    waitingDetail: "Waiting for the research plan",
  },
  {
    phase: "synthesizing",
    label: "Preparing report",
    waitingDetail: "Waiting for verified evidence",
  },
] as const;

const phaseIndex = new Map(readerPhases.map((entry, index) => [entry.phase, index]));

function toReaderPhase(phase: ReportPhase): ReaderProgressPhase | null {
  switch (phase) {
    case "index":
      return "reading";
    case "plan":
      return "planning";
    case "retrieval":
    case "perspective":
      return "researching";
    case "composition":
      return "synthesizing";
    default:
      return null;
  }
}

function readySectionCount(state: ReportState): number {
  return Math.min(
    6,
    [
      state.compass,
      state.bias,
      state.journalistContext,
      state.supporting,
      state.contradicting,
      state.additionalContext,
    ].filter((section) => section.status === "ready" || section.status === "empty").length,
  );
}

function activeDetail(state: ReportState, phase: ReaderProgressPhase): string {
  if (phase === "reading") {
    if (state.indexed) {
      return `${state.indexed.paragraphCount} paragraphs indexed`;
    }
    return "Finding the article structure and claims";
  }
  if (phase === "planning") {
    const missions = state.plan?.missions.length ?? 0;
    return missions > 0
      ? `${missions} research mission${missions === 1 ? "" : "s"} planned`
      : "Choosing the smallest useful research plan";
  }
  if (phase === "researching") {
    const sources = Math.max(state.research?.acceptedSources ?? 0, state.ledger.sourceCount);
    const missions = state.research?.completedMissions ?? 0;
    if (sources > 0) {
      return `${sources} source${sources === 1 ? "" : "s"} accepted`;
    }
    if (missions > 0) {
      return `${missions} research mission${missions === 1 ? "" : "s"} checked`;
    }
    return "Comparing independent evidence";
  }

  const sections = readySectionCount(state);
  return sections > 0
    ? `${sections} of 6 report sections ready`
    : "Validating evidence and citations";
}

function elapsedSince(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0;
}

export interface AnalysisProgressState {
  phase: ReaderProgressPhase;
  label: string;
  detail: string;
  completed: number;
  total: number;
  elapsedMs: number;
  steps: ReadonlyArray<{
    phase: ReaderProgressPhase;
    label: string;
    detail: string;
    status: "waiting" | "active" | "complete";
  }>;
}

export function getAnalysisProgress(
  state: ReportState,
  now = Date.now(),
): AnalysisProgressState | null {
  if (!isAnalysisActive(state.phase)) return null;
  const phase = toReaderPhase(state.phase);
  if (!phase) return null;
  const activeIndex = phaseIndex.get(phase) ?? 0;
  const detail = activeDetail(state, phase);
  const entry = readerPhases[activeIndex]!;

  return {
    phase,
    label: entry.label,
    detail,
    completed: activeIndex,
    total: readerPhases.length,
    elapsedMs: elapsedSince(state.startedAt, now),
    steps: readerPhases.map((step, index) => ({
      ...step,
      detail:
        index < activeIndex ? "Complete" : index === activeIndex ? detail : step.waitingDetail,
      status: index < activeIndex ? "complete" : index === activeIndex ? "active" : "waiting",
    })),
  };
}

interface AnalysisProgressProps {
  state: ReportState;
  onCancel?: () => void;
}

export function AnalysisProgress({ state, onCancel }: AnalysisProgressProps) {
  const progress = getAnalysisProgress(state);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!progress) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progress?.phase, state.startedAt]);

  const liveProgress = progress ? getAnalysisProgress(state, now) : null;
  if (!liveProgress) return null;

  return (
    <section className="analysis-progress" aria-label="Analysis progress">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveProgress.label}. {liveProgress.detail}
      </p>
      <ol className="analysis-progress-timeline">
        {liveProgress.steps.map((step) => (
          <li
            className={`analysis-progress-step analysis-progress-step-${step.status}`}
            key={step.phase}
          >
            <span className="analysis-progress-marker" aria-hidden="true" />
            <span className="analysis-progress-copy">
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
          </li>
        ))}
      </ol>
      <div className="analysis-progress-actions">
        <span className="analysis-progress-elapsed" aria-hidden="true">
          {formatElapsedMs(liveProgress.elapsedMs)} elapsed
        </span>
        {onCancel ? (
          <button className="analysis-progress-cancel" type="button" onClick={onCancel}>
            Cancel analysis
          </button>
        ) : null}
      </div>
    </section>
  );
}
