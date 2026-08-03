import type { PipelineEvent } from "@perspectica/contracts/events";
import {
  createInitialReportState,
  reducePipelineEvent,
  type ReportState,
  type SectionState,
} from "./report-state";

export type ReportSectionKey =
  | "sourceList"
  | "compass"
  | "bias"
  | "journalistContext"
  | "supporting"
  | "contradicting"
  | "additionalContext";

type Listener = () => void;

/**
 * Small external store for the side panel. Section subscribers are notified
 * only when their own trusted snapshot changes; pipeline progress and ledger
 * counters never require evidence-section reconciliation in React.
 */
export class ReportStore {
  private state: ReportState = createInitialReportState();
  private readonly listeners = new Set<Listener>();
  private readonly sectionListeners = new Map<ReportSectionKey, Set<Listener>>();

  getSnapshot = (): ReportState => this.state;

  getSectionSnapshot<K extends ReportSectionKey>(section: K): ReportState[K] {
    return this.state[section];
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeSection = (section: ReportSectionKey, listener: Listener): (() => void) => {
    const listeners = this.sectionListeners.get(section) ?? new Set<Listener>();
    listeners.add(listener);
    this.sectionListeners.set(section, listeners);
    return () => listeners.delete(listener);
  };

  set(next: ReportState | ((current: ReportState) => ReportState)): void {
    const previous = this.state;
    const value = typeof next === "function" ? next(previous) : next;
    if (value === previous) return;
    this.state = value;
    for (const listener of this.listeners) listener();
    for (const section of this.sectionListeners.keys()) {
      if (previous[section] === value[section]) continue;
      for (const listener of this.sectionListeners.get(section) ?? []) listener();
    }
  }

  reset(state = createInitialReportState()): void {
    this.set(state);
  }

  apply(event: PipelineEvent): void {
    this.set((current) => reducePipelineEvent(current, event));
  }

  getSection<K extends ReportSectionKey>(section: K): SectionState<unknown> {
    return this.state[section] as SectionState<unknown>;
  }
}
