import { z } from "zod";
import { ReportSectionSchema, type ReportSection } from "./report";

const text = z.string().trim().min(1);

export const ContentKindSchema = z.enum(["source-text", "search-summary"]);
export type ContentKind = z.infer<typeof ContentKindSchema>;

export const EvidenceProviderSchema = z.enum(["free", "chatgpt", "exa"]);
export type EvidenceProvider = z.infer<typeof EvidenceProviderSchema>;

export const SourceTypeV2Schema = z.enum([
  "primary-record",
  "direct-source",
  "independent-reporting",
  "analysis",
  "commentary",
]);
export type SourceTypeV2 = z.infer<typeof SourceTypeV2Schema>;

export const EvidenceRelationshipV2Schema = z.enum([
  "supports",
  "contradicts",
  "qualifies",
  "adds-context",
]);
export type EvidenceRelationshipV2 = z.infer<typeof EvidenceRelationshipV2Schema>;

export const EvidenceContextSourceKindSchema = z.enum([
  "publication-history",
  "journalist-work",
  "comparable-coverage",
  "topic-context",
]);
export type EvidenceContextSourceKind = z.infer<typeof EvidenceContextSourceKindSchema>;

/**
 * A provider result is discovery input, not reader-facing evidence. Providers
 * may attach the retrieval mission that produced a result, but they may not
 * decide which article claim it supports or contradicts.
 */
export const EvidenceCandidateSchema = z.object({
  id: text.max(160),
  missionId: text.max(160).nullable(),
  sourceUrl: z.string().url(),
  title: text.max(1_000),
  publication: text.max(500),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  sourceType: SourceTypeV2Schema,
  contentKind: ContentKindSchema,
  content: text.max(20_000),
  /** Provider discovery context is never rendered as a source quotation. */
  discoveryContext: text.max(20_000).nullable(),
  discoveryExcerpt: text.max(4_000).nullable(),
  providerScore: z.number().min(0).max(1).nullable(),
  provider: EvidenceProviderSchema,
});
export type EvidenceCandidate = z.infer<typeof EvidenceCandidateSchema>;

const EvidenceContextSignalSchema = z.object({
  sourceKind: EvidenceContextSourceKindSchema,
  subject: text.max(500),
  score: z.number().min(-3).max(3),
  direction: z.enum(["left", "center", "right"]),
  strength: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  explanation: text.max(1_000),
});
export type EvidenceContextSignal = z.infer<typeof EvidenceContextSignalSchema>;

/** The only shape allowed to cross from adjudication into the evidence ledger. */
export const EvidenceAdjudicationSchema = z.object({
  candidateId: text.max(160),
  missionId: text.max(160),
  claimId: text.max(160).nullable().default(null),
  relationship: EvidenceRelationshipV2Schema,
  statement: text.max(1_200),
  excerpt: text.max(4_000).nullable().default(null),
  confidence: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  context: EvidenceContextSignalSchema.nullable().default(null),
});
export type EvidenceAdjudication = z.infer<typeof EvidenceAdjudicationSchema>;

export const SourceRecordSchema = z.object({
  id: text.max(160),
  canonicalUrl: z.string().url(),
  title: text.max(1_000),
  publication: text.max(500),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  sourceType: SourceTypeV2Schema,
  contentKind: ContentKindSchema,
  content: text.max(20_000),
  contentSignature: text.max(128),
  retrievedAt: z.string().datetime({ offset: true }),
  provider: EvidenceProviderSchema,
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const EvidenceValidationSchema = z.object({
  accepted: z.boolean(),
  provenance: z.enum(["verified-url", "article-link", "unknown"]),
  excerptMatches: z.boolean(),
  claimRelevant: z.boolean().default(false),
  relationshipChecked: z.boolean().default(false),
  reason: text.max(500),
});
export type EvidenceValidation = z.infer<typeof EvidenceValidationSchema>;

export const EvidenceAssertionSchema = z.object({
  id: text.max(160),
  sourceId: text.max(160),
  missionId: text.max(160),
  claimId: text.max(160).nullable(),
  relationship: EvidenceRelationshipV2Schema,
  statement: text.max(1_200),
  excerpt: text.max(4_000).nullable(),
  articleParagraphIds: z.array(text.max(128)).max(12),
  confidence: z.number().min(0).max(1),
  validation: EvidenceValidationSchema,
  context: EvidenceContextSignalSchema.nullable().default(null),
});
export type EvidenceAssertion = z.infer<typeof EvidenceAssertionSchema>;

/** Legacy reader-card shape kept only for migration/tests; providers use candidates. */
export const EvidenceCardSchema = z.object({
  missionId: text.max(160),
  claimId: text.max(160).nullable(),
  sourceUrl: z.string().url(),
  title: text.max(1_000),
  publication: text.max(500),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  statement: text.max(1_200),
  excerpt: text.max(4_000).nullable(),
  content: text.max(20_000),
  contentKind: ContentKindSchema,
  relationship: EvidenceRelationshipV2Schema,
  sourceType: SourceTypeV2Schema,
  confidence: z.number().min(0).max(1),
  provider: EvidenceProviderSchema,
});
export type EvidenceCard = z.infer<typeof EvidenceCardSchema>;

export const EvidenceBatchSchema = z.object({
  missionId: text.max(160),
  provider: EvidenceProviderSchema,
  candidates: z.array(EvidenceCandidateSchema).max(32),
  coveredMissionIds: z.array(text.max(160)).max(32).default([]),
  status: z.enum(["completed", "failed"]).default("completed"),
  error: text.max(500).nullable().default(null),
  searched: z.boolean(),
  cacheHit: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type EvidenceBatch = z.infer<typeof EvidenceBatchSchema>;

export const EvidenceGraphNodeSchema = z.object({
  id: text.max(160),
  kind: z.enum(["article", "claim", "source", "assertion", "section"]),
  label: text.max(1_000),
});
export type EvidenceGraphNode = z.infer<typeof EvidenceGraphNodeSchema>;

export const EvidenceGraphEdgeSchema = z.object({
  from: text.max(160),
  to: text.max(160),
  relation: text.max(120),
});
export type EvidenceGraphEdge = z.infer<typeof EvidenceGraphEdgeSchema>;

export const SufficiencySnapshotSchema = z.object({
  acceptedSources: z.number().int().nonnegative(),
  acceptedAssertions: z.number().int().nonnegative(),
  coveredClaims: z.number().int().nonnegative(),
  totalClaims: z.number().int().nonnegative(),
  meaningfulContradiction: z.boolean(),
  exhaustedMissions: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative().default(0),
  stop: z.boolean(),
  reason: text.max(500),
});
export type SufficiencySnapshot = z.infer<typeof SufficiencySnapshotSchema>;

export const SourceLedgerSnapshotSchema = z.object({
  sources: z.array(SourceRecordSchema).max(64),
  assertions: z.array(EvidenceAssertionSchema).max(96),
  graph: z.object({
    nodes: z.array(EvidenceGraphNodeSchema).max(256),
    edges: z.array(EvidenceGraphEdgeSchema).max(512),
  }),
  sufficiency: SufficiencySnapshotSchema,
  servedSections: z.record(ReportSectionSchema, z.array(text.max(160)).max(32)),
  completedMissionIds: z.array(text.max(160)).max(32).default([]),
  failedMissionIds: z.array(text.max(160)).max(32).default([]),
});
export type SourceLedgerSnapshot = z.infer<typeof SourceLedgerSnapshotSchema>;

export interface EvidenceRetriever {
  retrieve(plan: RetrievalPlan, signal: AbortSignal): AsyncIterable<EvidenceBatch>;
}

export interface RetrievalPlan {
  missions: readonly RetrievalMission[];
  maxSources: number;
  maxConcurrency: number;
  deadlineAt: number;
}

export interface RetrievalMission {
  id: string;
  claimIds: string[];
  purpose:
    | "primary-record"
    | "independent-verification"
    | "correction-or-qualification"
    | "comparable-coverage"
    | "journalist-context"
    | "publication-context"
    | "missing-background";
  queryVariants: string[];
  priority: number;
  estimatedCost: number;
  freshness: "breaking" | "recent" | "timeless";
  preferredSourceTypes: SourceTypeV2[];
  includeDomains: string[];
  excludeDomains: string[];
  canServeSections: ReportSection[];
}
