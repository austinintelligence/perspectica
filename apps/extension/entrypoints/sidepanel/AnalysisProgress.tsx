import { useEffect, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { LoadStatus, ReportState } from "./report-state";
import { formatElapsedMs } from "./streaming";

const terminalStatuses: LoadStatus[] = ["ready", "empty", "error"];

const laneLabels: Readonly<Record<string, string>> = {
  compass: "Comparing related coverage",
  bias: "Reading article framing",
  journalistContext: "Checking journalist context",
  supporting: "Checking supporting evidence",
  contradicting: "Checking contradicting evidence",
  additionalContext: "Adding useful context",
};

export interface AnalysisProgressState {
  label: string;
  detail: string;
  completed: number;
  total: number;
  elapsedMs: number;
}

function isComplete(status: LoadStatus): boolean {
  return terminalStatuses.includes(status);
}

function elapsedSince(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0;
}

/**
 * Derives copy from actual extraction and section events. There is deliberately
 * no timer-based percentage: a lane is counted only after its result arrives.
 */
export function getAnalysisProgress(
  state: ReportState,
  now = Date.now(),
): AnalysisProgressState | null {
  if (state.phase !== "extracting" && state.phase !== "analyzing") return null;

  if (state.phase === "extracting" || !state.metadata) {
    return {
      label: "Reading the article",
      detail: "Preparing the report",
      completed: 0,
      total: 6,
      elapsedMs: elapsedSince(state.startedAt, now),
    };
  }

  const lanes = [
    ["compass", state.compass.status],
    ["bias", state.bias.status],
    ["journalistContext", state.journalistContext.status],
    ["supporting", state.supporting.status],
    ["contradicting", state.contradicting.status],
    ["additionalContext", state.additionalContext.status],
  ] as const;
  const completed = lanes.filter(([, status]) => isComplete(status)).length;
  const activeLane = lanes.find(([, status]) => status === "loading")?.[0];
  const waiting = lanes.filter(([, status]) => status === "waiting").length;

  if (activeLane && completed === 0 && activeLane === "compass") {
    return {
      label: "Comparing related coverage",
      detail: "Researching independent sources",
      completed,
      total: lanes.length,
      elapsedMs: elapsedSince(state.startedAt, now),
    };
  }
  if (activeLane && completed <= 2) {
    return {
      label: laneLabels[activeLane] ?? "Checking source context",
      detail: `${completed} of ${lanes.length} sections ready`,
      completed,
      total: lanes.length,
      elapsedMs: elapsedSince(state.startedAt, now),
    };
  }
  return {
    label: waiting > 0 ? "Preparing research" : "Preparing the report",
    detail: `${completed} of ${lanes.length} sections ready`,
    completed,
    total: lanes.length,
    elapsedMs: elapsedSince(state.startedAt, now),
  };
}

interface AnalysisProgressProps {
  state: ReportState;
  onCancel?: () => void;
}

export function AnalysisProgress({ state, onCancel }: AnalysisProgressProps) {
  const progress = getAnalysisProgress(state);
  const reduceMotion = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!progress) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progress?.label, state.startedAt]);

  const liveProgress = progress ? getAnalysisProgress(state, now) : null;

  return (
    <AnimatePresence initial={false}>
      {liveProgress ? (
        <m.div
          className="analysis-progress"
          role="status"
          aria-live="polite"
          initial={reduceMotion ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
        >
          <span className="analysis-progress-dot" aria-hidden="true" />
          <span className="analysis-progress-copy">
            <AnimatePresence initial={false} mode="wait">
              <m.strong
                key={liveProgress.label}
                initial={reduceMotion ? false : { opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
              >
                {liveProgress.label}
              </m.strong>
            </AnimatePresence>
            <small>
              {liveProgress.detail} · {formatElapsedMs(liveProgress.elapsedMs)}
            </small>
          </span>
          <span className="analysis-progress-track" aria-hidden="true">
            <m.span
              className="analysis-progress-indicator"
              animate={reduceMotion ? { opacity: 1 } : { opacity: [0.55, 1, 0.55] }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
              }
            />
          </span>
          {onCancel ? (
            <button className="analysis-progress-cancel" type="button" onClick={onCancel}>
              Stop
            </button>
          ) : null}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
