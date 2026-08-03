import { PipelineEventSchema, type PipelineEvent } from "@perspectica/contracts/events";
import {
  AnalysisMetadataSchema,
  type ArticleDocument,
  type ResearchDepth,
} from "@perspectica/contracts";
import type { ArticleIndex } from "@perspectica/contracts/article";
import type { EvidenceRetriever } from "@perspectica/contracts/evidence";
import type { AnalysisPlan, ReportSection } from "@perspectica/contracts/report";
import {
  INTELLIGENCE_PIPELINE_VERSION,
  INTELLIGENCE_PROMPT_VERSION,
} from "@perspectica/contracts/limits";
import { buildArticleIndex } from "@perspectica/extraction";
import {
  resolveAnalysisBudget,
  type AnalysisBudget,
  type LegacyAnalysisBudgetMode,
} from "./budgets";
import { createAnalysisPlan } from "./planning/lens";
import { EvidenceLedger } from "./evidence/source-ledger";
import { retryMissingSections as retryRetrieval, runRetrieval } from "./retrieval/coordinator";
import { projectBias, projectReport, projectSourceList } from "./report/projector";
import { synthesizePerspective } from "./synthesis/perspective";
import { createTelemetry, noteTelemetry, type PipelineTelemetry } from "./telemetry";
import type { LanguageModel } from "ai";
import { adjudicateEvidence, type EvidenceAdjudicator } from "./evidence/adjudication";

export interface AnalysisInput {
  article: ArticleDocument;
  retriever: EvidenceRetriever;
  model?: LanguageModel;
  analysisId?: string;
  modelVersion?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  mode?: AnalysisBudget["mode"] | LegacyAnalysisBudgetMode;
  depth?: ResearchDepth;
  signal?: AbortSignal;
  now?: () => Date;
  createId?: () => string;
  onTelemetry?: (telemetry: PipelineTelemetry) => void;
  onArtifacts?: (artifacts: AnalysisArtifacts) => void | Promise<void>;
  adjudicator?: EvidenceAdjudicator;
}

export interface AnalysisArtifacts {
  analysisId: string;
  article: ArticleDocument;
  index: ArticleIndex;
  plan: AnalysisPlan;
  ledger: EvidenceLedger;
  budget: AnalysisBudget;
  telemetry: PipelineTelemetry;
}

export interface TargetedRetryInput {
  artifacts: AnalysisArtifacts;
  retriever: EvidenceRetriever;
  sections: readonly ReportSection[];
  signal?: AbortSignal;
  now?: () => Date;
  onTelemetry?: (telemetry: PipelineTelemetry) => void;
  adjudicator?: EvidenceAdjudicator;
}

function randomId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function createEvent(
  type: PipelineEvent["type"],
  analysisId: string,
  data: unknown,
  now: () => Date,
): PipelineEvent {
  return PipelineEventSchema.parse({ type, analysisId, emittedAt: now().toISOString(), data });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Analysis cancelled", "AbortError");
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError"),
  );
}

function pipelineErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message.trim() || fallback).slice(0, 1_000);
}

export async function* analyzeArticle(input: AnalysisInput): AsyncGenerator<PipelineEvent> {
  const now = input.now ?? (() => new Date());
  const analysisId = input.analysisId ?? randomId("analysis");
  const createId = input.createId ?? (() => randomId("plan"));
  const budget = resolveAnalysisBudget(
    input.mode ?? "balanced",
    input.reasoningEffort === "none"
      ? "low"
      : input.reasoningEffort === "xhigh" || input.reasoningEffort === "max"
        ? "high"
        : (input.reasoningEffort ?? "medium"),
  );
  const telemetry = createTelemetry(() => now().valueOf());
  const startedAt = now();
  const metadata = AnalysisMetadataSchema.parse({
    analysisId,
    articleFingerprint: input.article.fingerprint,
    mode: input.model ? "live" : "demo",
    pipelineVersion: INTELLIGENCE_PIPELINE_VERSION,
    promptVersion: INTELLIGENCE_PROMPT_VERSION,
    modelVersion: input.modelVersion ?? "deterministic-v2",
    reasoningEffort: input.reasoningEffort ?? "medium",
    startedAt: startedAt.toISOString(),
    contentType: input.article.contentType,
    researchDepth: input.depth ?? (budget.mode === "quick" ? "quick" : budget.mode),
  });
  const emit = (type: PipelineEvent["type"], data: unknown): PipelineEvent => {
    const event = createEvent(type, analysisId, data, now);
    noteTelemetry(telemetry, `${type}:${JSON.stringify(data).length}`, () => now().valueOf());
    input.onTelemetry?.(telemetry);
    return event;
  };

  try {
    yield emit("analysis.started", metadata);
    const index = buildArticleIndex(input.article);
    yield emit("phase.changed", {
      phase: "indexed",
      message: "Article structure indexed locally.",
    });
    yield emit("article.indexed", {
      fingerprint: index.fingerprint,
      index: { version: index.version, meta: index.meta, extraction: index.extraction },
      paragraphCount: index.paragraphOrder.length,
      sentenceCount: Object.keys(index.sentences).length,
      claimSeedCount: index.claimSeeds.length,
    });
    yield emit("metadata.ready", {
      title: index.meta.title,
      author: index.meta.author,
      publication: index.meta.publication,
      publishedAt: index.meta.publishedAt,
      contentType: index.meta.contentType,
    });
    yield emit("worksCited.ready", projectSourceList(index));
    yield emit("phase.changed", {
      phase: "planning",
      message: "Planning global research missions.",
    });
    const plan = await createAnalysisPlan(index, budget, {
      model: input.model,
      signal: input.signal,
      createId,
      onUsage: (usage) => {
        telemetry.modelCalls += 1;
        telemetry.debugRing.push(`${usage.phase}.input=${usage.inputCharacters}`);
      },
    });
    throwIfAborted(input.signal);
    const preliminaryLedger = new EvidenceLedger(index, plan, budget);
    yield emit("lens.ready", {
      plan,
      provisionalCompass: plan.applicability.compass.applicable
        ? projectReport(index, plan, preliminaryLedger).compass
        : null,
      provisionalBias: projectBias(plan),
      missionCount: plan.missions.length,
    });
    yield emit("phase.changed", {
      phase: "retrieving",
      message: `Checking ${plan.missions.length} evidence missions.`,
    });
    const ledger = preliminaryLedger;
    const candidates = [];
    for await (const progress of runRetrieval({
      retriever: input.retriever,
      plan,
      ledger,
      budget,
      signal: input.signal ?? new AbortController().signal,
      now: () => now().valueOf(),
    })) {
      telemetry.searchCalls += progress.batch.searched ? 1 : 0;
      telemetry.cacheHits += progress.batch.cacheHit ? 1 : 0;
      candidates.push(...progress.batch.candidates);
      const snapshot = ledger.snapshot();
      yield emit("research.progress", {
        candidateCount: progress.candidateCount,
        completedMissions: progress.completedMissions,
        totalMissions: progress.totalMissions,
        acceptedSources: snapshot.sufficiency.acceptedSources,
        acceptedAssertions: snapshot.sufficiency.acceptedAssertions,
        sufficiency: snapshot.sufficiency.reason,
      });
      yield emit("ledger.updated", {
        sourceCount: snapshot.sources.length,
        assertionCount: snapshot.assertions.length,
      });
    }
    throwIfAborted(input.signal);
    yield emit("phase.changed", {
      phase: "adjudicating",
      message: "Adjudicating candidate sources against exact article claims.",
    });
    const decisions = await adjudicateEvidence({
      article: index,
      plan,
      candidates,
      budget,
      signal: input.signal,
      adjudicator: input.adjudicator,
      onAttempt: () => {
        telemetry.modelCalls += 1;
      },
      onFailure: (error, failedCandidates) => {
        const missionIds = [
          ...new Set(
            failedCandidates.flatMap((candidate) =>
              candidate.missionId
                ? [candidate.missionId]
                : plan.missions.map((mission) => mission.id),
            ),
          ),
        ];
        ledger.markMissionsFailed(
          missionIds,
          pipelineErrorMessage(error, "Evidence adjudication was unavailable."),
        );
        noteTelemetry(
          telemetry,
          `adjudication.degraded=${pipelineErrorMessage(error, "model batch unavailable")}`,
        );
      },
    });
    ledger.acceptAdjudications(decisions);
    yield emit("ledger.updated", {
      sourceCount: ledger.getSources().length,
      assertionCount: ledger.getAssertions().length,
      snapshot: ledger.snapshot(),
    });
    await input.onArtifacts?.({
      analysisId,
      article: input.article,
      index,
      plan,
      ledger,
      budget,
      telemetry,
    });
    const perspective = synthesizePerspective(index, plan, ledger);
    yield emit("perspective.ready", {
      compass: perspective.compass,
      journalistContext: perspective.journalistContext,
    });
    yield emit("phase.changed", {
      phase: "composing",
      message: "Writing the report from the shared evidence graph.",
    });
    const projected = projectReport(index, plan, ledger);
    yield emit("section.ready", { section: "bias", data: projected.bias });
    yield emit("section.ready", {
      section: "journalist-context",
      data: projected.journalistContext,
    });
    yield emit("section.ready", { section: "supporting", data: projected.evidence.supporting });
    yield emit("section.ready", {
      section: "contradicting",
      data: projected.evidence.contradicting,
    });
    yield emit("section.ready", {
      section: "additional-context",
      data: projected.evidence.additionalContext,
    });
    yield emit("worksCited.ready", projected.sourceList);
    const completedAt = now();
    const failedSections = failedSectionsForReport(
      [
        "compass",
        "bias",
        "journalist-context",
        "supporting",
        "contradicting",
        "additional-context",
      ],
      ledger,
      projected,
    );
    for (const section of failedSections) {
      yield emit("section.failed", {
        section,
        message: "This section needs another evidence pass.",
        retryable: true,
      });
    }
    const status = failedSections.length > 0 ? "partial" : "complete";
    yield emit("phase.changed", {
      phase: status === "complete" ? "complete" : "partial",
      message:
        status === "complete"
          ? "Report complete."
          : "Report complete with limited external evidence.",
    });
    yield emit("analysis.completed", {
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.valueOf() - startedAt.valueOf()),
      status,
      failedSections,
      acceptedSources: ledger.getSources().length,
      acceptedAssertions: ledger.getAssertions().length,
    });
    telemetry.finalLatencyMs = completedAt.valueOf() - telemetry.startedAt;
    input.onTelemetry?.(telemetry);
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      yield emit("phase.changed", { phase: "cancelled", message: "Analysis cancelled." });
      yield emit("analysis.cancelled", { message: "Analysis cancelled." });
      return;
    }
    const message = pipelineErrorMessage(error, "The analysis pipeline failed.");
    yield emit("phase.changed", { phase: "failed", message });
    yield emit("analysis.failed", { message, retryable: true });
  }
}

function failedSectionsForReport(
  sections: readonly ReportSection[],
  ledger: EvidenceLedger,
  projected: ReturnType<typeof projectReport>,
): ReportSection[] {
  return sections.filter((section) => {
    const hasFailedMission = ledger.plan.missions.some(
      (mission) => ledger.isMissionFailed(mission.id) && mission.canServeSections.includes(section),
    );
    if (!hasFailedMission) return false;
    if (ledger.hasEvidenceForSection(section)) return false;
    // Bias is projected from article-owned language. A failed context mission
    // cannot invalidate it. Likewise, retain a defensible article-led compass
    // and let the contextual copy disclose that no outside signal was verified.
    if (section === "bias") return false;
    if (section === "compass") {
      return projected.compass.score === null || projected.compass.evidence.length === 0;
    }
    return section !== "works-cited";
  });
}

/** Retry only requested report lanes against the existing evidence graph. */
export async function* retryArticleSections(
  input: TargetedRetryInput,
): AsyncGenerator<PipelineEvent> {
  const now = input.now ?? (() => new Date());
  const { artifacts } = input;
  const signal = input.signal ?? new AbortController().signal;
  const emit = (type: PipelineEvent["type"], data: unknown): PipelineEvent =>
    createEvent(type, artifacts.analysisId, data, now);

  try {
    const requested = [...new Set(input.sections)].filter((section) => section !== "works-cited");
    yield emit("phase.changed", {
      phase: "retrieving",
      message: "Retrying only the incomplete research lanes.",
    });
    const candidates = [];
    for await (const progress of retryRetrieval({
      retriever: input.retriever,
      plan: artifacts.plan,
      ledger: artifacts.ledger,
      budget: artifacts.budget,
      signal,
      sections: requested,
      now: () => now().valueOf(),
    })) {
      throwIfAborted(signal);
      candidates.push(...progress.batch.candidates);
      const snapshot = artifacts.ledger.snapshot();
      yield emit("research.progress", {
        candidateCount: progress.candidateCount,
        completedMissions: progress.completedMissions,
        totalMissions: progress.totalMissions,
        acceptedSources: snapshot.sufficiency.acceptedSources,
        acceptedAssertions: snapshot.sufficiency.acceptedAssertions,
        sufficiency: snapshot.sufficiency.reason,
      });
      yield emit("ledger.updated", {
        sourceCount: snapshot.sources.length,
        assertionCount: snapshot.assertions.length,
      });
    }
    throwIfAborted(signal);
    yield emit("phase.changed", {
      phase: "adjudicating",
      message: "Re-evaluating candidate sources against the requested lanes.",
    });
    const decisions = await adjudicateEvidence({
      article: artifacts.index,
      plan: artifacts.plan,
      candidates,
      budget: artifacts.budget,
      signal,
      adjudicator: input.adjudicator,
      onAttempt: () => {
        artifacts.telemetry.modelCalls += 1;
      },
      onFailure: (error, failedCandidates) => {
        const missionIds = [
          ...new Set(
            failedCandidates.flatMap((candidate) =>
              candidate.missionId
                ? [candidate.missionId]
                : artifacts.plan.missions.map((mission) => mission.id),
            ),
          ),
        ];
        artifacts.ledger.markMissionsFailed(
          missionIds,
          pipelineErrorMessage(error, "Evidence adjudication was unavailable."),
        );
        noteTelemetry(
          artifacts.telemetry,
          `retry.adjudication.degraded=${pipelineErrorMessage(error, "model batch unavailable")}`,
        );
      },
    });
    artifacts.ledger.acceptAdjudications(decisions);
    const perspective = synthesizePerspective(artifacts.index, artifacts.plan, artifacts.ledger);
    yield emit("perspective.ready", {
      compass: perspective.compass,
      journalistContext: perspective.journalistContext,
    });
    yield emit("phase.changed", {
      phase: "composing",
      message: "Updating only the requested report sections.",
    });
    const projected = projectReport(artifacts.index, artifacts.plan, artifacts.ledger);
    const requestedSet = new Set(requested);
    if (requestedSet.has("bias"))
      yield emit("section.ready", { section: "bias", data: projected.bias });
    if (requestedSet.has("journalist-context")) {
      yield emit("section.ready", {
        section: "journalist-context",
        data: projected.journalistContext,
      });
    }
    if (requestedSet.has("supporting")) {
      yield emit("section.ready", { section: "supporting", data: projected.evidence.supporting });
    }
    if (requestedSet.has("contradicting")) {
      yield emit("section.ready", {
        section: "contradicting",
        data: projected.evidence.contradicting,
      });
    }
    if (requestedSet.has("additional-context")) {
      yield emit("section.ready", {
        section: "additional-context",
        data: projected.evidence.additionalContext,
      });
    }
    if (input.sections.includes("works-cited"))
      yield emit("worksCited.ready", projected.sourceList);
    const failedSections = failedSectionsForReport(
      input.sections,
      artifacts.ledger,
      projected,
    ).filter((section) => section !== "works-cited");
    for (const section of failedSections) {
      yield emit("section.failed", {
        section,
        message: "This section remains limited by the available evidence.",
        retryable: true,
      });
    }
    const completedAt = now();
    yield emit("phase.changed", {
      phase: failedSections.length > 0 ? "partial" : "complete",
      message:
        failedSections.length > 0
          ? "Requested sections remain limited by available evidence."
          : "Requested sections updated.",
    });
    yield emit("analysis.completed", {
      completedAt: completedAt.toISOString(),
      durationMs: 0,
      status: failedSections.length > 0 ? "partial" : "complete",
      failedSections,
      acceptedSources: artifacts.ledger.getSources().length,
      acceptedAssertions: artifacts.ledger.getAssertions().length,
    });
    input.onTelemetry?.(artifacts.telemetry);
  } catch (error) {
    if (isAbortError(error, signal)) {
      yield emit("phase.changed", { phase: "cancelled", message: "Retry cancelled." });
      yield emit("analysis.cancelled", { message: "Retry cancelled." });
      return;
    }
    const message = pipelineErrorMessage(error, "The targeted retry failed.");
    yield emit("phase.changed", { phase: "failed", message });
    yield emit("analysis.failed", { message, retryable: true });
  }
}

export { resolveAnalysisBudget } from "./budgets";
