export const ARTICLE_INDEX_VERSION = "article-index-v2" as const;
export const INTELLIGENCE_PIPELINE_VERSION = "intelligence-graph-v2" as const;
export const INTELLIGENCE_PROMPT_VERSION = "lens-planner-v2" as const;

export const ANALYSIS_LIMITS = {
  quick: {
    deepPassageCharacters: 16_000,
    maxClaims: 4,
    maxMissions: 4,
    maxSources: 6,
    maxConcurrency: 2,
    totalDeadlineMs: 45_000,
    maxSearchQueries: 4,
    maxSearchResults: 12,
    maxSourceReads: 4,
    maxModelSteps: 4,
    maxArticleContextChars: 24_000,
    maxSourceContextChars: 6_000,
    specialistTimeoutMs: 45_000,
    modelOutputTokens: 1_600,
  },
  balanced: {
    deepPassageCharacters: 22_000,
    maxClaims: 5,
    maxMissions: 5,
    maxSources: 8,
    maxConcurrency: 2,
    totalDeadlineMs: 70_000,
    maxSearchQueries: 8,
    maxSearchResults: 24,
    maxSourceReads: 8,
    maxModelSteps: 6,
    maxArticleContextChars: 48_000,
    maxSourceContextChars: 10_000,
    specialistTimeoutMs: 90_000,
    modelOutputTokens: 2_400,
  },
  deep: {
    deepPassageCharacters: 30_000,
    maxClaims: 6,
    maxMissions: 6,
    maxSources: 12,
    maxConcurrency: 2,
    totalDeadlineMs: 110_000,
    maxSearchQueries: 12,
    maxSearchResults: 40,
    maxSourceReads: 12,
    maxModelSteps: 8,
    maxArticleContextChars: 48_000,
    maxSourceContextChars: 14_000,
    specialistTimeoutMs: 120_000,
    modelOutputTokens: 3_200,
  },
  verified: {
    deepPassageCharacters: 30_000,
    maxClaims: 8,
    maxMissions: 8,
    maxSources: 16,
    maxConcurrency: 2,
    totalDeadlineMs: 180_000,
    maxSearchQueries: 18,
    maxSearchResults: 60,
    maxSourceReads: 16,
    maxModelSteps: 8,
    maxArticleContextChars: 48_000,
    maxSourceContextChars: 18_000,
    specialistTimeoutMs: 180_000,
    modelOutputTokens: 4_000,
  },
} as const;

export type AnalysisBudgetMode = keyof typeof ANALYSIS_LIMITS;

export const MAX_ARTICLE_SPINE_CHARACTERS = 24_000;
export const MAX_SOURCE_CONTENT_CHARACTERS = 20_000;
export const MAX_EVIDENCE_ASSERTIONS = 96;
export const MAX_DEBUG_RING_ENTRIES = 64;
export const MAX_JOURNAL_EVENTS = 256;
