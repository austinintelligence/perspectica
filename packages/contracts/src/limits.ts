export const ARTICLE_INDEX_VERSION = "article-index-v2" as const;
export const INTELLIGENCE_PIPELINE_VERSION = "intelligence-graph-v2" as const;
export const INTELLIGENCE_PROMPT_VERSION = "lens-planner-v2" as const;

export const ANALYSIS_LIMITS = {
  fast: {
    deepPassageCharacters: 16_000,
    maxClaims: 4,
    maxMissions: 4,
    maxSources: 6,
    maxConcurrency: 2,
    totalDeadlineMs: 45_000,
  },
  balanced: {
    deepPassageCharacters: 22_000,
    maxClaims: 5,
    maxMissions: 5,
    maxSources: 8,
    maxConcurrency: 2,
    totalDeadlineMs: 70_000,
  },
  deep: {
    deepPassageCharacters: 30_000,
    maxClaims: 6,
    maxMissions: 6,
    maxSources: 12,
    maxConcurrency: 2,
    totalDeadlineMs: 110_000,
  },
} as const;

export type AnalysisBudgetMode = keyof typeof ANALYSIS_LIMITS;

export const MAX_ARTICLE_SPINE_CHARACTERS = 24_000;
export const MAX_SOURCE_CONTENT_CHARACTERS = 20_000;
export const MAX_EVIDENCE_ASSERTIONS = 96;
export const MAX_DEBUG_RING_ENTRIES = 64;
export const MAX_JOURNAL_EVENTS = 256;
