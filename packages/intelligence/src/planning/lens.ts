import { Output, streamText, type LanguageModel } from "ai";
import {
  AnalysisPlanSchema,
  type AnalysisPlan,
  type ArticleBiasSignal,
  type ArticleCompassSignal,
  type PlannedClaim,
  type ResearchMission,
} from "@perspectica/contracts/report";
import type { ArticleIndex } from "@perspectica/contracts/article";
import type { AnalysisBudget } from "../budgets";
import { selectArticleContext } from "../article/context-selector";
import { buildLensPrompt, LENS_PROMPT_VERSION, LENS_SYSTEM_PROMPT } from "./prompts";

export interface AnalysisPlanOptions {
  model?: LanguageModel;
  signal?: AbortSignal;
  createId?: () => string;
  onUsage?: (usage: { phase: "lens"; inputCharacters: number; outputCharacters: number }) => void;
}

const LEFT_TERMS =
  /\b(?:redistribution|public housing|labor rights|collective|equity|inequality|climate action|regulation|universal)\b/i;
const RIGHT_TERMS =
  /\b(?:free market|tax cut|border security|private property|individual responsibility|deregulation|national sovereignty|tradition)\b/i;
const BIAS_TECHNIQUES = [
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
] as const;

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `plan-${Date.now()}`;
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

function articleSignals(index: ArticleIndex): {
  compass: ArticleCompassSignal[];
  bias: ArticleBiasSignal[];
} {
  const compass: ArticleCompassSignal[] = [];
  const bias: ArticleBiasSignal[] = [];
  for (const seed of index.claimSeeds.slice(0, 8)) {
    const paragraph = index.paragraphs[seed.paragraphIds[0]!];
    const sentenceId = seed.sentenceIds[0];
    if (!paragraph || !sentenceId) continue;
    const left = LEFT_TERMS.test(seed.text);
    const right = RIGHT_TERMS.test(seed.text);
    const score = left === right ? 0 : left ? -1 : 1;
    compass.push({
      paragraphIds: seed.paragraphIds,
      sentenceIds: seed.sentenceIds.slice(0, 4),
      score,
      direction: score < -0.2 ? "left" : score > 0.2 ? "right" : "center",
      strength: left || right ? 0.45 : 0.22,
      explanation:
        left || right
          ? "The article uses a policy-framing signal in this passage."
          : "The passage is primarily descriptive and provides low-strength center evidence.",
      attributed: Boolean(paragraph.speaker),
    });
    if (
      /\b(?:obviously|always|never|radical|shocking|so-called|disastrous|extreme)\b/i.test(
        seed.text,
      )
    ) {
      const match =
        seed.text.match(
          /\b(?:obviously|always|never|radical|shocking|so-called|disastrous|extreme)\b[^.?!]{0,120}/i,
        )?.[0] ?? seed.text;
      bias.push({
        id: `bias-${seed.id}`,
        technique: BIAS_TECHNIQUES[0],
        paragraphId: seed.paragraphIds[0]!,
        sentenceId,
        excerpt: compact(match, 500),
        explanation: "The wording may add evaluative emphasis beyond the underlying factual claim.",
        confidence: 0.48,
        attributed: Boolean(paragraph.speaker),
      });
    }
  }
  return { compass: compass.slice(0, 8), bias: bias.slice(0, 4) };
}

function planClaims(index: ArticleIndex, budget: AnalysisBudget): PlannedClaim[] {
  return [...index.claimSeeds]
    .sort(
      (left, right) => right.checkability - left.checkability || left.id.localeCompare(right.id),
    )
    .slice(0, budget.maxClaims)
    .map((seed, indexInPlan) => ({
      id: `claim-${seed.id.replace(/^claim-seed-/, "")}`,
      text: seed.text,
      paragraphIds: seed.paragraphIds,
      sentenceIds: seed.sentenceIds,
      importance: Math.max(0.45, Math.min(1, 0.9 - indexInPlan * 0.08)),
      uncertainty: Math.max(0.25, Math.min(1, 1 - seed.checkability)),
      researchValue: Math.max(0.25, Math.min(1, seed.checkability)),
      queryHints: [
        compact(seed.entities.concat(seed.quantities, seed.dates).join(" ") || seed.text, 360),
      ],
    }));
}

function mission(
  idValue: string,
  claimIds: string[],
  purpose: ResearchMission["purpose"],
  query: string,
  sections: ResearchMission["canServeSections"],
  priority: number,
): ResearchMission {
  return {
    id: idValue,
    claimIds,
    purpose,
    queryVariants: [compact(query, 500)],
    priority: Math.max(0, Math.min(1, priority)),
    estimatedCost: 1,
    freshness: "recent",
    preferredSourceTypes:
      purpose === "primary-record"
        ? ["primary-record", "direct-source"]
        : ["independent-reporting", "analysis"],
    includeDomains: [],
    excludeDomains: [],
    canServeSections: sections,
  };
}

function deterministicPlan(
  index: ArticleIndex,
  budget: AnalysisBudget,
  createId: () => string,
): AnalysisPlan {
  const claims = planClaims(index, budget);
  const signals = articleSignals(index);
  const missions: ResearchMission[] = [];
  if (claims[0]) {
    missions.push(
      mission(
        "mission-primary",
        [claims[0].id],
        "primary-record",
        claims[0].queryHints[0] ?? claims[0].text,
        ["supporting", "contradicting", "additional-context"],
        0.98,
      ),
    );
  }
  if (claims.length > 0) {
    missions.push(
      mission(
        "mission-verify",
        claims.slice(0, 3).map((claim) => claim.id),
        "independent-verification",
        claims
          .slice(0, 3)
          .map((claim) => claim.queryHints[0] ?? claim.text)
          .join("; "),
        ["supporting", "contradicting"],
        0.9,
      ),
    );
  }
  if (claims.some((claim) => claim.uncertainty > 0.5)) {
    missions.push(
      mission(
        "mission-qualify",
        claims
          .filter((claim) => claim.uncertainty > 0.5)
          .slice(0, 2)
          .map((claim) => claim.id),
        "correction-or-qualification",
        "independent qualification or correction for the central claims",
        ["contradicting", "additional-context"],
        0.82,
      ),
    );
  }
  if (index.meta.author && index.meta.author.length >= 3) {
    missions.push(
      mission(
        "mission-journalist",
        [],
        "journalist-context",
        `${index.meta.author} public reporting work`,
        ["journalist-context", "compass"],
        0.52,
      ),
    );
  }
  if (index.meta.publication) {
    missions.push(
      mission(
        "mission-publication",
        [],
        "publication-context",
        `${index.meta.publication} publication history and comparable coverage`,
        ["compass", "additional-context"],
        0.45,
      ),
    );
  }
  const applicability = {
    compass: {
      applicable: signals.compass.length > 0,
      confidence: signals.compass.length > 0 ? 0.7 : 0.9,
      reason:
        signals.compass.length > 0
          ? "Article passages contain spectrum-relevant framing signals."
          : "No meaningful article-spectrum signal was detected.",
    },
    bias: {
      applicable: signals.bias.length > 0,
      confidence: signals.bias.length > 0 ? 0.62 : 0.85,
      reason:
        signals.bias.length > 0
          ? "Potential article-owned framing language was found."
          : "No strong article-owned framing technique was detected.",
    },
    "journalist-context": {
      applicable: Boolean(index.meta.author),
      confidence: index.meta.author ? 0.82 : 0.96,
      reason: index.meta.author
        ? "A named author is available for bounded public-context research."
        : "No credible named author identity is available.",
    },
    supporting: {
      applicable: claims.length > 0,
      confidence: 0.9,
      reason:
        claims.length > 0
          ? "Central externally checkable claims are present."
          : "No central claims were extracted.",
    },
    contradicting: {
      applicable: claims.some((claim) => claim.uncertainty > 0.45),
      confidence: 0.72,
      reason: claims.some((claim) => claim.uncertainty > 0.45)
        ? "At least one claim merits qualification checking."
        : "No central claim currently merits a contradiction mission.",
    },
    "additional-context": {
      applicable: claims.length > 0,
      confidence: 0.7,
      reason: "Additional context is retained only when it prevents a likely misunderstanding.",
    },
    "works-cited": {
      applicable: true,
      confidence: 1,
      reason: "Article links are always projected as works cited.",
    },
  } as const;
  const plan: AnalysisPlan = {
    id: createId(),
    overview: compact(
      `${index.meta.title} contains ${claims.length} central externally checkable claim${claims.length === 1 ? "" : "s"}.`,
      1_000,
    ),
    claims,
    articleSignals: signals,
    missions: missions
      .sort((left, right) => right.priority - left.priority)
      .slice(0, budget.maxMissions),
    applicability,
    unresolvedQuestions: claims
      .slice(0, 4)
      .map((claim) => `What primary or independent record best tests: ${compact(claim.text, 220)}`),
    requestedParagraphIds: [],
    contextCharacters: 0,
  };
  return AnalysisPlanSchema.parse(plan);
}

function normalizePlan(
  candidate: AnalysisPlan,
  index: ArticleIndex,
  budget: AnalysisBudget,
  fallback: AnalysisPlan,
): AnalysisPlan {
  const paragraphIds = new Set(index.paragraphOrder);
  const sentenceIds = new Set(Object.keys(index.sentences));
  const claims = candidate.claims
    .map((claim) => ({
      ...claim,
      paragraphIds: claim.paragraphIds.filter((value) => paragraphIds.has(value)),
      sentenceIds: claim.sentenceIds.filter((value) => sentenceIds.has(value)),
    }))
    .filter((claim) => claim.paragraphIds.length > 0 && claim.sentenceIds.length > 0)
    .slice(0, budget.maxClaims);
  if (claims.length === 0) return fallback;
  const claimIds = new Set(claims.map((claim) => claim.id));
  const missions = candidate.missions
    .map((missionValue) => ({
      ...missionValue,
      claimIds: missionValue.claimIds.filter((value) => claimIds.has(value)),
    }))
    .filter(
      (missionValue) =>
        missionValue.claimIds.length > 0 ||
        missionValue.purpose === "journalist-context" ||
        missionValue.purpose === "publication-context",
    )
    .slice(0, budget.maxMissions);
  return AnalysisPlanSchema.parse({
    ...candidate,
    id: candidate.id || fallback.id,
    claims,
    missions: missions.length > 0 ? missions : fallback.missions,
    requestedParagraphIds: candidate.requestedParagraphIds
      .filter((value) => paragraphIds.has(value))
      .slice(0, 24),
    contextCharacters: Math.min(candidate.contextCharacters, budget.deepPassageCharacters),
  });
}

export async function createAnalysisPlan(
  index: ArticleIndex,
  budget: AnalysisBudget,
  options: AnalysisPlanOptions = {},
): Promise<AnalysisPlan> {
  const context = selectArticleContext(index, budget);
  const fallback = deterministicPlan(index, budget, options.createId ?? id);
  fallback.contextCharacters = context.characters;
  if (!options.model) return AnalysisPlanSchema.parse(fallback);
  const prompt = buildLensPrompt(index, context, budget);
  options.onUsage?.({ phase: "lens", inputCharacters: prompt.length, outputCharacters: 0 });
  try {
    const result = streamText({
      model: options.model,
      abortSignal: options.signal,
      output: Output.object({ schema: AnalysisPlanSchema }),
      system: LENS_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: budget.modelOutputTokens,
      maxRetries: 1,
      timeout: {
        totalMs: Math.min(45_000, budget.totalDeadlineMs),
        firstChunkMs: 30_000,
        chunkMs: 15_000,
      },
    });
    for await (const _ of result.partialOutputStream) options.signal?.throwIfAborted();
    const plan = AnalysisPlanSchema.parse(await result.output);
    options.onUsage?.({
      phase: "lens",
      inputCharacters: prompt.length,
      outputCharacters: JSON.stringify(plan).length,
    });
    return normalizePlan(plan, index, budget, fallback);
  } catch {
    // A deterministic plan is a valid bounded fallback. Retrieval is never
    // replaced by a section-wide legacy dossier after this point.
    return fallback;
  }
}

export { LENS_PROMPT_VERSION };
