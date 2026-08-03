import { z } from "zod";
import {
  AdditionalContextResultSchema,
  AnalysisMetadataSchema,
  BiasResultSchema,
  CompassResultSchema,
  EvidenceSectionSchema,
  JournalistContextResultSchema,
  SourceListResultSchema,
} from "./index";
import { ArticleIndexSchema } from "./article";
import { AnalysisPlanSchema, ReportSectionSchema } from "./report";
import { SourceLedgerSnapshotSchema } from "./evidence";

const text = z.string().trim().min(1);

export const PipelinePhaseSchema = z.enum([
  "indexed",
  "planning",
  "retrieving",
  "adjudicating",
  "composing",
  "complete",
  "partial",
  "failed",
  "cancelled",
]);
export type PipelinePhase = z.infer<typeof PipelinePhaseSchema>;

const event = <T extends string, S extends z.ZodTypeAny>(type: T, data: S) =>
  z.object({
    type: z.literal(type),
    analysisId: text.max(160),
    emittedAt: z.string().datetime({ offset: true }),
    data,
  });

export const PipelineEventSchema = z.discriminatedUnion("type", [
  event("analysis.started", AnalysisMetadataSchema),
  event(
    "article.indexed",
    z.object({
      fingerprint: text.max(128),
      index: ArticleIndexSchema.pick({ version: true, meta: true, extraction: true }),
      paragraphCount: z.number().int().nonnegative(),
      sentenceCount: z.number().int().nonnegative(),
      claimSeedCount: z.number().int().nonnegative(),
    }),
  ),
  event("phase.changed", z.object({ phase: PipelinePhaseSchema, message: text.max(500) })),
  event(
    "metadata.ready",
    z.object({
      title: text.max(1_000),
      author: z.string().trim().max(500).nullable(),
      publication: z.string().trim().max(500).nullable(),
      publishedAt: z.string().datetime({ offset: true }).nullable(),
      contentType: z.enum(["news", "analysis", "opinion", "unknown"]),
    }),
  ),
  event("sourceList.ready", SourceListResultSchema),
  event(
    "lens.ready",
    z.object({
      plan: AnalysisPlanSchema,
      provisionalCompass: CompassResultSchema.nullable(),
      provisionalBias: BiasResultSchema,
      missionCount: z.number().int().nonnegative(),
    }),
  ),
  event(
    "research.progress",
    z.object({
      completedMissions: z.number().int().nonnegative(),
      totalMissions: z.number().int().nonnegative(),
      acceptedSources: z.number().int().nonnegative(),
      acceptedAssertions: z.number().int().nonnegative(),
      sufficiency: text.max(500),
    }),
  ),
  event(
    "perspective.ready",
    z.object({
      compass: CompassResultSchema.nullable(),
      journalistContext: JournalistContextResultSchema,
    }),
  ),
  event(
    "ledger.updated",
    z.object({
      sourceCount: z.number().int().nonnegative(),
      assertionCount: z.number().int().nonnegative(),
      snapshot: SourceLedgerSnapshotSchema.optional(),
    }),
  ),
  event(
    "section.ready",
    z.discriminatedUnion("section", [
      z.object({ section: z.literal("bias"), data: BiasResultSchema }),
      z.object({ section: z.literal("journalist-context"), data: JournalistContextResultSchema }),
      z.object({ section: z.literal("supporting"), data: EvidenceSectionSchema }),
      z.object({ section: z.literal("contradicting"), data: EvidenceSectionSchema }),
      z.object({ section: z.literal("additional-context"), data: AdditionalContextResultSchema }),
    ]),
  ),
  event("worksCited.ready", SourceListResultSchema),
  event(
    "analysis.completed",
    z.object({
      completedAt: z.string().datetime({ offset: true }),
      durationMs: z.number().int().nonnegative(),
      status: z.enum(["complete", "partial"]),
      failedSections: z.array(ReportSectionSchema).max(7),
      acceptedSources: z.number().int().nonnegative(),
      acceptedAssertions: z.number().int().nonnegative(),
    }),
  ),
  event("analysis.failed", z.object({ message: text.max(1_000), retryable: z.boolean() })),
  event("analysis.cancelled", z.object({ message: text.max(500) })),
]);
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

export const AnalysisEnvelopeSchema = z.object({
  protocol: z.literal(2),
  jobId: text.max(160),
  runToken: text.max(160),
  sequence: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  event: PipelineEventSchema,
});
export type AnalysisEnvelope = z.infer<typeof AnalysisEnvelopeSchema>;
