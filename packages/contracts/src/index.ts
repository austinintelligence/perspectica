import { z } from "zod";
export { normalizeCanonicalUrl } from "./canonical-url";

const trimmedText = z.string().trim();
const requiredText = trimmedText.min(1);
const httpUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "Expected an HTTP or HTTPS URL",
  });

export const ContentTypeSchema = z.enum(["news", "analysis", "opinion", "unknown"]);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const ArticleParagraphKindSchema = z.enum(["heading", "paragraph", "quote"]);
export type ArticleParagraphKind = z.infer<typeof ArticleParagraphKindSchema>;

/**
 * Article payload limits protect runtime messages and model context while
 * leaving room for normal long-form reporting. The limit is measured over the
 * normalized paragraph text, not the serialized JSON envelope.
 */
export const ARTICLE_MAX_CONTENT_CHARS = 300_000;
export const ARTICLE_MAX_PARAGRAPH_CHARS = 20_000;
export const ARTICLE_MAX_PARAGRAPHS = 2_000;
export const ARTICLE_MAX_LINKS = 1_000;

export const ArticleStatusSchema = z.enum(["article", "uncertain", "non-article"]);
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;

export const ArticleParagraphSchema = z.object({
  id: requiredText,
  index: z.number().int().nonnegative(),
  kind: ArticleParagraphKindSchema,
  text: requiredText.max(ARTICLE_MAX_PARAGRAPH_CHARS),
  speaker: trimmedText.max(500).nullable().optional(),
});
export type ArticleParagraph = z.infer<typeof ArticleParagraphSchema>;

export const ArticleLinkSchema = z.object({
  id: requiredText,
  label: trimmedText.max(1_000),
  url: httpUrl,
  paragraphId: requiredText.nullable().optional(),
});
export type ArticleLink = z.infer<typeof ArticleLinkSchema>;

const ArticleParagraphsSchema = z
  .array(ArticleParagraphSchema)
  .min(1)
  .max(ARTICLE_MAX_PARAGRAPHS)
  .superRefine((paragraphs, context) => {
    const contentChars = paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0);
    if (contentChars > ARTICLE_MAX_CONTENT_CHARS) {
      context.addIssue({
        code: "too_big",
        maximum: ARTICLE_MAX_CONTENT_CHARS,
        origin: "number",
        inclusive: true,
        path: [],
        message: `Article content exceeds ${ARTICLE_MAX_CONTENT_CHARS.toLocaleString("en-US")} characters`,
      });
    }
  });

export const ArticleDocumentSchema = z.object({
  fingerprint: requiredText.max(128),
  canonicalUrl: httpUrl,
  title: requiredText.max(1_000),
  author: trimmedText.max(500).nullable(),
  publication: trimmedText.max(500).nullable(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  language: trimmedText.max(50).nullable(),
  contentType: ContentTypeSchema,
  paragraphs: ArticleParagraphsSchema,
  links: z.array(ArticleLinkSchema).max(ARTICLE_MAX_LINKS),
  extraction: z.object({
    extractorVersion: requiredText,
    extractedAt: z.string().datetime({ offset: true }),
    wordCount: z.number().int().nonnegative(),
    /** Added as optional fields so persisted documents from older builds stay wire-compatible. */
    articleStatus: ArticleStatusSchema.optional(),
    contentChars: z.number().int().nonnegative().optional(),
    contentTruncated: z.boolean().optional(),
    rejectionReason: trimmedText.max(500).nullable().optional(),
  }),
});
export type ArticleDocument = z.infer<typeof ArticleDocumentSchema>;

export const PoliticalIssueFamilySchema = z.enum([
  "government",
  "security",
  "religion",
  "inclusion",
  "private-life",
  "property",
  "redistribution",
  "economic-principles",
  "ecology",
]);
export type PoliticalIssueFamily = z.infer<typeof PoliticalIssueFamilySchema>;

export const PoliticalSpectrumDirectionSchema = z.enum(["left", "center", "right"]);
export type PoliticalSpectrumDirection = z.infer<typeof PoliticalSpectrumDirectionSchema>;

export const PoliticalSpectrumEvidenceSchema = z.object({
  id: requiredText,
  paragraphId: requiredText,
  excerpt: requiredText.max(4_000),
  speaker: trimmedText.max(500).nullable(),
  endorsedByArticle: z.boolean(),
  score: z.number().min(-3).max(3),
  direction: PoliticalSpectrumDirectionSchema,
  strength: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  explanation: requiredText.max(2_000),
});
export type PoliticalSpectrumEvidence = z.infer<typeof PoliticalSpectrumEvidenceSchema>;

// Keep the old export names as wire-compatible aliases while the package and
// event names migrate from the original two-axis prototype.
export const CompassDirectionSchema = PoliticalSpectrumDirectionSchema;
export type CompassDirection = PoliticalSpectrumDirection;
export const CompassEvidenceSchema = PoliticalSpectrumEvidenceSchema;
export type CompassEvidence = PoliticalSpectrumEvidence;

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const PoliticalSpectrumLabelSchema = z.enum([
  "far-left",
  "left",
  "center-left",
  "center",
  "center-right",
  "right",
  "far-right",
  "unclear",
]);
export type PoliticalSpectrumLabel = z.infer<typeof PoliticalSpectrumLabelSchema>;
export const CompassLabelSchema = PoliticalSpectrumLabelSchema;
export type CompassLabel = PoliticalSpectrumLabel;

export const PoliticalContextSourceKindSchema = z.enum([
  "publication-history",
  "journalist-work",
  "comparable-coverage",
  "topic-context",
]);
export type PoliticalContextSourceKind = z.infer<typeof PoliticalContextSourceKindSchema>;

/**
 * Describes what a reader-facing citation is grounded in.
 *
 * `source-excerpt` is copied from retrieved page text and may be rendered as a
 * quotation. `search-summary` is a provider-generated, URL-attributed search
 * note. It may support a cautious paraphrase, but must never be displayed as a
 * quotation or described as page text.
 *
 * The field remains optional on exact-excerpt variants so stored reports from
 * older builds stay wire-compatible.
 */
export const SourceCitationKindSchema = z.enum(["source-excerpt", "search-summary"]);
export type SourceCitationKind = z.infer<typeof SourceCitationKindSchema>;

/**
 * AI-selected, bounded weighting for the political-spectrum decision. The
 * article remains the anchor; the research mix is normalized again after
 * source validation so discarded evidence cannot affect the final score.
 */
export const PoliticalContextWeightingSchema = z.object({
  articleWeight: z.number().min(0.4).max(0.6),
  publicationHistory: z.number().min(0).max(1),
  journalistWork: z.number().min(0).max(1),
  comparableCoverage: z.number().min(0).max(1),
  topicContext: z.number().min(0).max(1),
  rationale: requiredText.max(600),
});
export type PoliticalContextWeighting = z.infer<typeof PoliticalContextWeightingSchema>;

const PoliticalContextSignalBaseSchema = z.object({
  id: requiredText,
  sourceKind: PoliticalContextSourceKindSchema,
  subject: requiredText.max(500),
  score: z.number().min(-3).max(3),
  direction: PoliticalSpectrumDirectionSchema,
  strength: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  explanation: requiredText.max(1_000),
  sourceTitle: requiredText.max(1_000),
  publication: requiredText.max(500),
  url: httpUrl,
});
export const PoliticalContextSignalSchema = z.union([
  PoliticalContextSignalBaseSchema.extend({
    citationKind: z.literal("source-excerpt").optional(),
    excerpt: requiredText.max(2_000),
  }),
  PoliticalContextSignalBaseSchema.extend({
    citationKind: z.literal("search-summary"),
    excerpt: z.null(),
  }),
]);
export type PoliticalContextSignal = z.infer<typeof PoliticalContextSignalSchema>;

export const PoliticalContextResultSchema = z.object({
  status: z.enum(["ready", "empty"]),
  summary: requiredText.max(1_000),
  signals: z.array(PoliticalContextSignalSchema).max(8),
  weighting: PoliticalContextWeightingSchema.optional(),
});
export type PoliticalContextResult = z.infer<typeof PoliticalContextResultSchema>;

export const CompassBasisSchema = z.enum([
  "article-led",
  "context-assisted",
  "context-led",
  "calibrated-fallback",
  "insufficient",
]);
export type CompassBasis = z.infer<typeof CompassBasisSchema>;

export const PoliticalSpectrumResultSchema = z.object({
  label: PoliticalSpectrumLabelSchema,
  displayLabel: requiredText,
  score: z.number().min(-3).max(3).nullable(),
  confidence: ConfidenceSchema,
  confidenceScore: z.number().min(0).max(1),
  explanation: requiredText.max(3_000),
  evidence: z.array(CompassEvidenceSchema).max(12),
  basis: CompassBasisSchema,
  context: PoliticalContextResultSchema,
  influence: z.object({
    article: z.number().min(0).max(1),
    publication: z.number().min(0).max(1),
    journalist: z.number().min(0).max(1),
    comparableCoverage: z.number().min(0).max(1),
    topicContext: z.number().min(0).max(1),
  }),
});
export type PoliticalSpectrumResult = z.infer<typeof PoliticalSpectrumResultSchema>;
export const CompassResultSchema = PoliticalSpectrumResultSchema;
export type CompassResult = PoliticalSpectrumResult;

export const BiasTechniqueSchema = z.enum([
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
export type BiasTechnique = z.infer<typeof BiasTechniqueSchema>;

export const BiasFindingSchema = z.object({
  id: requiredText,
  technique: BiasTechniqueSchema,
  displayName: requiredText.max(200),
  paragraphId: requiredText,
  excerpt: requiredText.max(4_000),
  explanation: requiredText.max(2_000),
  confidence: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  prominence: z.number().min(0).max(1),
});
export type BiasFinding = z.infer<typeof BiasFindingSchema>;

export const ReaderCitationSchema = z.object({
  id: requiredText,
  title: requiredText.max(1_000),
  publication: requiredText.max(500),
  url: httpUrl,
  publishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ReaderCitation = z.infer<typeof ReaderCitationSchema>;

export const ReaderFindingSchema = z.object({
  id: requiredText,
  text: requiredText.max(900),
  citationIds: z.array(requiredText).max(4),
  keySourceNote: trimmedText.max(500).nullable().optional(),
});
export type ReaderFinding = z.infer<typeof ReaderFindingSchema>;

export const ReaderCopySchema = z.object({
  lead: requiredText.max(700),
  findings: z.array(ReaderFindingSchema).max(3),
});
export type ReaderCopy = z.infer<typeof ReaderCopySchema>;

export const BiasResultSchema = z.object({
  status: z.enum(["ready", "empty"]),
  summary: requiredText.max(3_000),
  findings: z.array(BiasFindingSchema).max(3),
  readerCopy: ReaderCopySchema.optional(),
  citations: z.array(ReaderCitationSchema).max(8).optional(),
});
export type BiasResult = z.infer<typeof BiasResultSchema>;

export const ResearchClaimSchema = z.object({
  id: requiredText,
  text: requiredText.max(3_000),
  paragraphIds: z.array(requiredText).min(1).max(10),
  importance: z.number().min(0).max(1),
  queryHints: z.array(requiredText.max(500)).max(5),
});
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;

export const ResearchSectionSchema = z.enum([
  "political-spectrum",
  "bias",
  "journalist-context",
  "supporting",
  "contradicting",
  "additional-context",
]);
export type ResearchSection = z.infer<typeof ResearchSectionSchema>;

export const DossierPassageSchema = z.object({
  section: ResearchSectionSchema,
  paragraphIds: z.array(requiredText).min(1).max(8),
  text: requiredText.max(4_000),
  reason: requiredText.max(500),
});
export type DossierPassage = z.infer<typeof DossierPassageSchema>;

export const ArticleDossierSchema = z.object({
  overview: requiredText.max(1_000),
  claims: z.array(ResearchClaimSchema).min(1).max(8),
  entities: z.array(requiredText.max(200)).max(20),
  topics: z.array(requiredText.max(200)).max(12),
  passages: z.array(DossierPassageSchema).max(24),
  researchQuestions: z
    .array(
      z.object({
        section: ResearchSectionSchema,
        question: requiredText.max(500),
      }),
    )
    .max(18),
});
export type ArticleDossier = z.infer<typeof ArticleDossierSchema>;

export const SearchMissionSchema = z.object({
  section: ResearchSectionSchema,
  objective: requiredText.max(800),
  queries: z.array(requiredText.max(390)).min(3).max(3),
  unresolvedQuestions: z.array(requiredText.max(500)).max(3),
});
export type SearchMission = z.infer<typeof SearchMissionSchema>;

export const SourceTypeSchema = z.enum([
  "primary-record",
  "direct-source",
  "independent-reporting",
  "analysis",
  "commentary",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const EvidenceRelationshipSchema = z.enum([
  "supports",
  "contradicts",
  "qualifies",
  "adds-context",
]);
export type EvidenceRelationship = z.infer<typeof EvidenceRelationshipSchema>;

const ExternalSourceBaseSchema = z.object({
  id: requiredText,
  claimId: requiredText.nullable(),
  title: requiredText.max(1_000),
  publication: requiredText.max(500),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  relationship: EvidenceRelationshipSchema,
  relationshipExplanation: requiredText.max(2_000),
  url: httpUrl,
  sourceType: SourceTypeSchema,
  publicationContext: trimmedText.max(500).nullable(),
});
export const ExternalSourceSchema = z.union([
  ExternalSourceBaseSchema.extend({
    citationKind: z.literal("source-excerpt").optional(),
    excerpt: requiredText.max(4_000),
  }),
  ExternalSourceBaseSchema.extend({
    citationKind: z.literal("search-summary"),
    excerpt: z.null(),
  }),
]);
export type ExternalSource = z.infer<typeof ExternalSourceSchema>;

const JournalistContextFindingBaseSchema = z.object({
  id: requiredText,
  summary: requiredText.max(2_000),
  relevanceExplanation: requiredText.max(2_000),
  sourceTitle: requiredText.max(1_000),
  publication: requiredText.max(500),
  url: httpUrl,
});
export const JournalistContextFindingSchema = z.union([
  JournalistContextFindingBaseSchema.extend({
    citationKind: z.literal("source-excerpt").optional(),
    excerpt: requiredText.max(4_000),
  }),
  JournalistContextFindingBaseSchema.extend({
    citationKind: z.literal("search-summary"),
    excerpt: z.null(),
  }),
]);
export type JournalistContextFinding = z.infer<typeof JournalistContextFindingSchema>;

export const EmptyResultReasonSchema = z.enum([
  "not-applicable",
  "no-claims",
  "no-search-results",
  "no-verified-evidence",
]);
export type EmptyResultReason = z.infer<typeof EmptyResultReasonSchema>;

export const JournalistContextResultSchema = z.object({
  status: z.enum(["ready", "empty"]),
  summary: requiredText.max(2_000),
  findings: z.array(JournalistContextFindingSchema).max(3),
  emptyReason: EmptyResultReasonSchema.optional(),
  readerCopy: ReaderCopySchema.optional(),
});
export type JournalistContextResult = z.infer<typeof JournalistContextResultSchema>;

export const EvidenceSectionSchema = z.object({
  status: z.enum(["ready", "empty"]),
  summary: requiredText.max(2_000),
  sources: z.array(ExternalSourceSchema).max(3),
  emptyReason: EmptyResultReasonSchema.optional(),
  readerCopy: ReaderCopySchema.optional(),
});
export type EvidenceSection = z.infer<typeof EvidenceSectionSchema>;

export const AdditionalContextResultSchema = z.object({
  status: z.enum(["ready", "empty"]),
  summary: requiredText.max(2_000),
  sources: z.array(ExternalSourceSchema).max(2),
  emptyReason: EmptyResultReasonSchema.optional(),
  readerCopy: ReaderCopySchema.optional(),
});
export type AdditionalContextResult = z.infer<typeof AdditionalContextResultSchema>;

export const OriginalSourceSchema = z.object({
  id: requiredText,
  label: trimmedText.max(1_000),
  url: httpUrl,
  paragraphId: requiredText.nullable(),
});
export type OriginalSource = z.infer<typeof OriginalSourceSchema>;

export const SourceListResultSchema = z.object({
  status: z.enum(["ready", "empty"]),
  sources: z.array(OriginalSourceSchema).max(20),
});
export type SourceListResult = z.infer<typeof SourceListResultSchema>;

export const AnalysisMetadataSchema = z.object({
  analysisId: requiredText,
  articleFingerprint: requiredText,
  mode: z.enum(["demo", "live"]),
  pipelineVersion: requiredText,
  promptVersion: requiredText,
  modelVersion: requiredText,
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
  startedAt: z.string().datetime({ offset: true }),
  contentType: ContentTypeSchema,
});
export type AnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>;

export const AnalysisModelSchema = z.enum(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.4"]);
export type AnalysisModel = z.infer<typeof AnalysisModelSchema>;

export const AnalysisReasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type AnalysisReasoningEffort = z.infer<typeof AnalysisReasoningEffortSchema>;

export const AnalysisPreferencesSchema = z.object({
  model: AnalysisModelSchema,
  reasoningEffort: AnalysisReasoningEffortSchema,
});
export type AnalysisPreferences = z.infer<typeof AnalysisPreferencesSchema>;

export const AnalyzeRequestSchema = z.object({
  article: ArticleDocumentSchema,
  client: z.object({
    extensionVersion: requiredText,
  }),
  preferences: AnalysisPreferencesSchema.optional(),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

const event = <TType extends string, TData extends z.ZodType>(type: TType, data: TData) =>
  z.object({
    type: z.literal(type),
    analysisId: requiredText,
    emittedAt: z.string().datetime({ offset: true }),
    data,
  });

export const AnalysisEventSchema = z.discriminatedUnion("type", [
  event("analysis.started", AnalysisMetadataSchema),
  event(
    "metadata.ready",
    z.object({
      title: requiredText,
      author: trimmedText.nullable(),
      publication: trimmedText.nullable(),
      publishedAt: z.string().datetime({ offset: true }).nullable(),
      contentType: ContentTypeSchema,
    }),
  ),
  event("sourceList.ready", SourceListResultSchema),
  event("compass.provisional", CompassResultSchema),
  event("compass.ready", CompassResultSchema),
  event("bias.ready", BiasResultSchema),
  event("journalistContext.ready", JournalistContextResultSchema),
  event("supporting.ready", EvidenceSectionSchema),
  event("contradicting.ready", EvidenceSectionSchema),
  event("additionalContext.ready", AdditionalContextResultSchema),
  event(
    "section.failed",
    z.object({
      section: z.enum([
        "compass",
        "bias",
        "journalist-context",
        "supporting",
        "contradicting",
        "additional-context",
      ]),
      message: requiredText.max(1_000),
      retryable: z.boolean(),
    }),
  ),
  event(
    "analysis.completed",
    z.object({
      completedAt: z.string().datetime({ offset: true }),
      durationMs: z.number().int().nonnegative(),
      status: z.enum(["complete", "partial"]),
      failedSections: z
        .array(
          z.enum([
            "compass",
            "bias",
            "journalist-context",
            "supporting",
            "contradicting",
            "additional-context",
          ]),
        )
        .max(6),
    }),
  ),
]);
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;

export const AnalysisReportSchema = z.object({
  metadata: AnalysisMetadataSchema,
  article: ArticleDocumentSchema.pick({
    fingerprint: true,
    canonicalUrl: true,
    title: true,
    author: true,
    publication: true,
    publishedAt: true,
    contentType: true,
  }),
  sourceList: SourceListResultSchema,
  compass: CompassResultSchema,
  bias: BiasResultSchema,
  journalistContext: JournalistContextResultSchema,
  supporting: EvidenceSectionSchema,
  contradicting: EvidenceSectionSchema,
  additionalContext: AdditionalContextResultSchema,
});
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

export const ExtractionRequestMessageSchema = z.object({
  type: z.literal("perspectica.extract-article"),
});
export type ExtractionRequestMessage = z.infer<typeof ExtractionRequestMessageSchema>;
