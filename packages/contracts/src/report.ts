import { z } from "zod";

const text = z.string().trim().min(1);

export const ArticleBiasTechniqueSchema = z.enum([
  "word-choice",
  "speculation",
  "unsubstantiated-claims",
  "cherry-picking",
  "source-selection",
  "whataboutism",
  "false-balance",
  "false-dichotomy",
  "flawed-comparison",
  "generalization",
  "ad-hominem",
  "emotional-sensationalism",
  "straw-man",
]);
export type ArticleBiasTechnique = z.infer<typeof ArticleBiasTechniqueSchema>;

export const ReportSectionSchema = z.enum([
  "compass",
  "bias",
  "journalist-context",
  "supporting",
  "contradicting",
  "additional-context",
  "works-cited",
]);
export type ReportSection = z.infer<typeof ReportSectionSchema>;

export const ApplicabilityDecisionSchema = z.object({
  applicable: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: text.max(500),
});
export type ApplicabilityDecision = z.infer<typeof ApplicabilityDecisionSchema>;

export const ArticleCompassSignalSchema = z.object({
  paragraphIds: z.array(text.max(128)).min(1).max(8),
  sentenceIds: z.array(text.max(160)).max(8),
  score: z.number().min(-3).max(3),
  direction: z.enum(["left", "center", "right"]),
  strength: z.number().min(0).max(1),
  explanation: text.max(1_000),
  attributed: z.boolean(),
});
export type ArticleCompassSignal = z.infer<typeof ArticleCompassSignalSchema>;

export const ArticleBiasSignalSchema = z.object({
  id: text.max(160),
  technique: ArticleBiasTechniqueSchema,
  paragraphId: text.max(128),
  sentenceId: text.max(160).nullable(),
  excerpt: text.max(4_000),
  explanation: text.max(1_000),
  confidence: z.number().min(0).max(1),
  attributed: z.boolean(),
});
export type ArticleBiasSignal = z.infer<typeof ArticleBiasSignalSchema>;

export const PlannedClaimSchema = z.object({
  id: text.max(160),
  text: text.max(1_200),
  paragraphIds: z.array(text.max(128)).min(1).max(8),
  sentenceIds: z.array(text.max(160)).min(1).max(12),
  importance: z.number().min(0).max(1),
  uncertainty: z.number().min(0).max(1),
  researchValue: z.number().min(0).max(1),
  queryHints: z.array(text.max(500)).max(4),
});
export type PlannedClaim = z.infer<typeof PlannedClaimSchema>;

export const ResearchMissionSchema = z.object({
  id: text.max(160),
  claimIds: z.array(text.max(160)).max(8),
  purpose: z.enum([
    "primary-record",
    "independent-verification",
    "correction-or-qualification",
    "comparable-coverage",
    "journalist-context",
    "publication-context",
    "missing-background",
  ]),
  queryVariants: z.array(text.max(500)).min(1).max(3),
  priority: z.number().min(0).max(1),
  estimatedCost: z.number().positive().max(100),
  freshness: z.enum(["breaking", "recent", "timeless"]),
  preferredSourceTypes: z.array(text.max(80)).max(5),
  includeDomains: z.array(text.max(300)).max(20),
  excludeDomains: z.array(text.max(300)).max(20),
  canServeSections: z.array(ReportSectionSchema).min(1).max(7),
});
export type ResearchMission = z.infer<typeof ResearchMissionSchema>;

export const AnalysisPlanSchema = z.object({
  id: text.max(160),
  overview: text.max(2_000),
  claims: z.array(PlannedClaimSchema).min(1).max(6),
  articleSignals: z.object({
    compass: z.array(ArticleCompassSignalSchema).max(8),
    bias: z.array(ArticleBiasSignalSchema).max(6),
  }),
  missions: z.array(ResearchMissionSchema).max(7),
  applicability: z.record(ReportSectionSchema, ApplicabilityDecisionSchema),
  unresolvedQuestions: z.array(text.max(500)).max(12),
  requestedParagraphIds: z.array(text.max(128)).max(24),
  contextCharacters: z.number().int().nonnegative(),
});
export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>;

export const ReportElementSchema = z.object({
  id: text.max(160),
  title: text.max(500).nullable(),
  text: text.max(1_500),
  excerpt: text.max(4_000).nullable(),
  sourceIds: z.array(text.max(160)).max(4),
});
export type ReportElement = z.infer<typeof ReportElementSchema>;

export const ReportSectionSnapshotSchema = z.object({
  section: ReportSectionSchema,
  status: z.enum(["ready", "empty", "unavailable"]),
  summary: text.max(2_000),
  elements: z.array(ReportElementSchema).max(8),
  sourceIds: z.array(text.max(160)).max(32),
});
export type ReportSectionSnapshot = z.infer<typeof ReportSectionSnapshotSchema>;
