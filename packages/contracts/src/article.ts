import { z } from "zod";
import type { ArticleDocument, ContentType } from "./index";

const text = z.string().trim().min(1);

export const ParagraphIdSchema = text.max(128);
export type ParagraphId = z.infer<typeof ParagraphIdSchema>;
export const SentenceIdSchema = text.max(160);
export type SentenceId = z.infer<typeof SentenceIdSchema>;

export const ArticleBlockSummarySchema = z.object({
  id: ParagraphIdSchema,
  index: z.number().int().nonnegative(),
  kind: z.enum(["heading", "paragraph", "quote"]),
  preview: text.max(360),
  headingPath: z.array(text.max(240)).max(8),
  sentenceCount: z.number().int().nonnegative(),
  entityCount: z.number().int().nonnegative(),
  quantityCount: z.number().int().nonnegative(),
  linkIds: z.array(text.max(128)).max(64),
});
export type ArticleBlockSummary = z.infer<typeof ArticleBlockSummarySchema>;

export const IndexedParagraphSchema = z.object({
  id: ParagraphIdSchema,
  index: z.number().int().nonnegative(),
  kind: z.enum(["heading", "paragraph", "quote"]),
  text: text.max(20_000),
  preview: text.max(360),
  speaker: z.string().trim().max(500).nullable(),
  sentenceIds: z.array(SentenceIdSchema).max(128),
  headingPath: z.array(text.max(240)).max(8),
  linkIds: z.array(text.max(128)).max(64),
  position: z.number().min(0).max(1),
  tokenCount: z.number().int().nonnegative(),
});
export type IndexedParagraph = z.infer<typeof IndexedParagraphSchema>;

export const IndexedSentenceSchema = z.object({
  id: SentenceIdSchema,
  paragraphId: ParagraphIdSchema,
  index: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: text.max(4_000),
  speaker: z.string().trim().max(500).nullable(),
  attributionVerb: z.string().trim().max(80).nullable(),
  isQuoted: z.boolean(),
});
export type IndexedSentence = z.infer<typeof IndexedSentenceSchema>;

export const EntityMentionSchema = z.object({
  text: text.max(200),
  normalized: text.max(200),
  kind: z.enum(["person", "organization", "place", "policy", "unknown"]),
  paragraphId: ParagraphIdSchema,
  sentenceId: SentenceIdSchema.nullable(),
});
export type EntityMention = z.infer<typeof EntityMentionSchema>;

export const QuantityMentionSchema = z.object({
  text: text.max(120),
  normalized: text.max(120),
  kind: z.enum(["number", "percentage", "currency", "measurement"]),
  paragraphId: ParagraphIdSchema,
  sentenceId: SentenceIdSchema.nullable(),
});
export type QuantityMention = z.infer<typeof QuantityMentionSchema>;

export const DateMentionSchema = z.object({
  text: text.max(120),
  normalized: text.max(120),
  paragraphId: ParagraphIdSchema,
  sentenceId: SentenceIdSchema.nullable(),
});
export type DateMention = z.infer<typeof DateMentionSchema>;

export const IndexedArticleLinkSchema = z.object({
  id: text.max(128),
  url: z.string().url(),
  label: text.max(1_000),
  paragraphId: ParagraphIdSchema.nullable(),
  classification: z.enum([
    "same-publication",
    "external",
    "likely-primary",
    "social",
    "navigation",
    "promotional",
    "unknown",
  ]),
  host: text.max(300),
});
export type IndexedArticleLink = z.infer<typeof IndexedArticleLinkSchema>;

export const DeterministicClaimSeedSchema = z.object({
  id: text.max(160),
  paragraphIds: z.array(ParagraphIdSchema).min(1).max(6),
  sentenceIds: z.array(SentenceIdSchema).min(1).max(8),
  text: text.max(1_200),
  entities: z.array(text.max(200)).max(8),
  quantities: z.array(text.max(120)).max(8),
  dates: z.array(text.max(120)).max(8),
  attribution: z.string().trim().max(500).nullable(),
  checkability: z.number().min(0).max(1),
});
export type DeterministicClaimSeed = z.infer<typeof DeterministicClaimSeedSchema>;

export const ArticleExtractionMetadataSchema = z.object({
  extractorVersion: text.max(100),
  indexedAt: z.string().datetime({ offset: true }),
  wordCount: z.number().int().nonnegative(),
  contentChars: z.number().int().nonnegative(),
  paragraphCount: z.number().int().nonnegative(),
  sentenceCount: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  contentTruncated: z.boolean(),
  articleStatus: z.enum(["article", "uncertain"]),
});
export type ArticleExtractionMetadata = z.infer<typeof ArticleExtractionMetadataSchema>;

export const ArticleIndexSchema = z.object({
  version: text.max(64),
  fingerprint: text.max(128),
  meta: z.object({
    title: text.max(1_000),
    author: z.string().trim().max(500).nullable(),
    publication: z.string().trim().max(500).nullable(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    canonicalUrl: z.string().url(),
    contentType: z.enum(["news", "analysis", "opinion", "unknown"]),
    language: z.string().trim().max(50).nullable(),
  }),
  outline: z.array(ArticleBlockSummarySchema).max(2_000),
  paragraphs: z.record(z.string(), IndexedParagraphSchema),
  paragraphOrder: z.array(ParagraphIdSchema).max(2_000),
  sentences: z.record(z.string(), IndexedSentenceSchema),
  entities: z.array(EntityMentionSchema).max(10_000),
  quantities: z.array(QuantityMentionSchema).max(10_000),
  dates: z.array(DateMentionSchema).max(10_000),
  links: z.array(IndexedArticleLinkSchema).max(1_000),
  claimSeeds: z.array(DeterministicClaimSeedSchema).max(128),
  extraction: ArticleExtractionMetadataSchema,
});
export type ArticleIndex = z.infer<typeof ArticleIndexSchema>;

export interface ArticleIndexSource {
  readonly article: ArticleDocument;
  readonly index: ArticleIndex;
}

export function articleMeta(index: ArticleIndex): {
  title: string;
  author: string | null;
  publication: string | null;
  publishedAt: string | null;
  contentType: ContentType;
} {
  return {
    title: index.meta.title,
    author: index.meta.author,
    publication: index.meta.publication,
    publishedAt: index.meta.publishedAt,
    contentType: index.meta.contentType,
  };
}
