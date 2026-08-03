import { useEffect, useState } from "react";
import type { ReportPhase, ReportState } from "./report-state";
import { isAnalysisActive } from "./report-state";
import { formatElapsedMs } from "./streaming";

const phaseLabels: Readonly<
  Record<Exclude<ReportPhase, "idle" | "complete" | "partial" | "error" | "cancelled">, string>
> = {
  index: "Indexing the article",
  plan: "Planning research",
  retrieval: "Retrieving evidence",
  perspective: "Comparing perspectives",
  composition: "Composing the report",
};

const phaseDetails: Readonly<
  Record<Exclude<ReportPhase, "idle" | "complete" | "partial" | "error" | "cancelled">, string>
> = {
  index: "Finding the article structure and claims",
  plan: "Selecting the smallest useful research missions",
  retrieval: "Checking accepted sources against the article",
  perspective: "Calibrating framing and publication context",
  composition: "Organizing the evidence into report sections",
};

const phaseOrder = ["index", "plan", "retrieval", "perspective", "composition"] as const;
type ActivePhase = (typeof phaseOrder)[number];

export interface AnalysisProgressState {
  phase: ActivePhase;
  label: string;
  detail: string;
  completed: number;
  total: number;
  elapsedMs: number;
}

function elapsedSince(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0;
}

export function getAnalysisProgress(
  state: ReportState,
  now = Date.now(),
): AnalysisProgressState | null {
  if (!isAnalysisActive(state.phase)) return null;
  const phase = state.phase as ActivePhase;
  const phaseIndex = phaseOrder.indexOf(phase);
  const research = state.research;
  const detail =
    phase === "retrieval" && research
      ? `${research.completedMissions} of ${research.totalMissions} missions checked`
      : phaseDetails[phase];
  return {
    phase,
    label: phaseLabels[phase],
    detail,
    completed: phaseIndex,
    total: phaseOrder.length,
    elapsedMs: elapsedSince(state.startedAt, now),
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

  const width = Math.max(0.08, liveProgress.completed / liveProgress.total);
  return (
    <div
      className={`analysis-progress analysis-progress-${liveProgress.phase}`}
      role="status"
      aria-live="polite"
    >
      <span className="analysis-progress-dot" aria-hidden="true" />
      <span className="analysis-progress-copy">
        <strong>{liveProgress.label}</strong>
        <small>
          {liveProgress.detail} · {formatElapsedMs(liveProgress.elapsedMs)}
        </small>
      </span>
      <span className="analysis-progress-track" aria-hidden="true">
        <span className="analysis-progress-indicator" style={{ transform: `scaleX(${width})` }} />
      </span>
      {onCancel ? (
        <button className="analysis-progress-cancel" type="button" onClick={onCancel}>
          Stop
        </button>
      ) : null}
    </div>
  );
}
