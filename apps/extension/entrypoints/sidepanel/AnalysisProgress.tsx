import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { LoadStatus, ReportState } from "./report-state";

const activeStatuses: LoadStatus[] = ["loading", "waiting"];

export interface AnalysisProgressState {
  label: string;
  detail: string;
  progress: number;
}

function isComplete(status: LoadStatus): boolean {
  return status === "ready" || status === "empty" || status === "error";
}

/**
 * Keeps the status language tied to real pipeline milestones rather than a
 * timer. It is intentionally concise: the report remains the focus.
 */
export function getAnalysisProgress(state: ReportState): AnalysisProgressState | null {
  if (state.phase !== "extracting" && state.phase !== "analyzing") return null;

  if (state.phase === "extracting" || !state.metadata) {
    return { label: "Reading the article", detail: "Preparing the report", progress: 8 };
  }

  const sections = [
    state.compass.status,
    state.bias.status,
    state.journalistContext.status,
    state.supporting.status,
    state.contradicting.status,
    state.additionalContext.status,
  ];
  const completed = sections.filter(isComplete).length;

  if (activeStatuses.includes(state.compass.status) && completed === 0) {
    return {
      label: "Comparing related coverage",
      detail: "Researching independent sources",
      progress: 18,
    };
  }
  if (completed <= 2) {
    return {
      label: "Checking source context",
      detail: "Reviewing publication and reporter context",
      progress: 24 + completed * 12,
    };
  }
  return {
    label: "Preparing the report",
    detail: "Organizing the evidence found so far",
    progress: 56 + completed * 7,
  };
}

export function AnalysisProgress({ state }: { state: ReportState }) {
  const progress = getAnalysisProgress(state);
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {progress ? (
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
                key={progress.label}
                initial={reduceMotion ? false : { opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
              >
                {progress.label}
              </m.strong>
            </AnimatePresence>
            <small>{progress.detail}</small>
          </span>
          <span className="analysis-progress-track" aria-hidden="true">
            <m.span
              animate={{ scaleX: progress.progress / 100 }}
              transition={{ duration: reduceMotion ? 0 : 0.42, ease: "easeOut" }}
            />
          </span>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
