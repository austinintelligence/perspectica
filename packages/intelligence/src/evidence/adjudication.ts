import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { ArticleIndex } from "@perspectica/contracts/article";
import {
  EvidenceAdjudicationSchema,
  type EvidenceAdjudication,
  type EvidenceCandidate,
} from "@perspectica/contracts/evidence";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import type { AnalysisBudget } from "../budgets";

const AdjudicationOutputSchema = z.object({
  decisions: z.array(EvidenceAdjudicationSchema).max(8),
});

export interface EvidenceAdjudicationInput {
  article: ArticleIndex;
  plan: AnalysisPlan;
  candidates: readonly EvidenceCandidate[];
  budget: AnalysisBudget;
  signal?: AbortSignal;
}

export interface EvidenceAdjudicator {
  adjudicate(input: EvidenceAdjudicationInput): Promise<EvidenceAdjudication[]>;
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

function buildPrompt(input: EvidenceAdjudicationInput): string {
  const claims = input.plan.claims
    .map((claim) => {
      const passages = claim.paragraphIds
        .map((paragraphId) => input.article.paragraphs[paragraphId]?.text)
        .filter((value): value is string => Boolean(value))
        .map((value) => compact(value, 700))
        .join(" | ");
      return `CLAIM ${claim.id} [paragraphs=${claim.paragraphIds.join(",")}] ${compact(claim.text, 700)}\nARTICLE PASSAGES: ${passages}`;
    })
    .join("\n");
  const missions = input.plan.missions
    .map(
      (mission) =>
        `MISSION ${mission.id} purpose=${mission.purpose} claims=${mission.claimIds.join(",") || "none"} queries=${mission.queryVariants.join("; ")}`,
    )
    .join("\n");
  const candidates = input.candidates
    .slice(0, Math.max(input.budget.maxSources * 4, 24))
    .map(
      (candidate) =>
        `CANDIDATE ${candidate.id} mission=${candidate.missionId ?? "global-search"} url=${candidate.sourceUrl} title=${compact(candidate.title, 300)} kind=${candidate.contentKind} sourceType=${candidate.sourceType}\nCONTENT: ${compact(candidate.content, 2_400)}\nDISCOVERY: ${compact(candidate.discoveryContext ?? "", 600)}`,
    )
    .join("\n\n");
  return [
    "ARTICLE CLAIMS",
    claims,
    "RESEARCH MISSIONS",
    missions,
    "RETRIEVED CANDIDATES",
    candidates,
  ].join("\n\n");
}

const SYSTEM_PROMPT = [
  "You are Perspectica's evidence adjudicator. You receive an article claim plan and provider discovery candidates.",
  "A provider candidate is not evidence by itself. Decide only when the candidate content directly supports the decision.",
  "Never assign a source to a claim or relationship because of mission purpose, array position, URL order, or provider score.",
  "For source-text candidates, return an exact contiguous excerpt copied from CONTENT. The statement must be a cautious source-backed paraphrase.",
  "For search-summary candidates, excerpt must be null. They may only produce adds-context or a contextual signal; never supports, contradicts, or qualifies.",
  "Supports, contradicts, and qualifies require an exact planned claim and a clear source-content anchor.",
  "Use context only for journalist-work, publication-history, comparable-coverage, or topic-context that is explicitly present in the candidate.",
  "Return no decision for irrelevant, ambiguous, self-referential, or discovery-only candidates. Do not write generic discovery prose such as 'surfaced a relevant source'.",
  "Return at most one short decision per candidate. Keep source excerpts contiguous and as short as possible (preferably under 600 characters).",
  "Every candidateId and missionId must be copied exactly from the input. Do not invent IDs.",
].join(" ");

export function createModelEvidenceAdjudicator(
  model: LanguageModel,
  onUsage?: (usage: { inputCharacters: number; outputCharacters: number }) => void,
): EvidenceAdjudicator {
  return {
    async adjudicate(input) {
      const prompt = buildPrompt(input);
      const result = await generateText({
        model,
        abortSignal: input.signal,
        output: Output.object({ schema: AdjudicationOutputSchema }),
        system: SYSTEM_PROMPT,
        prompt,
        maxRetries: 1,
        maxOutputTokens: input.budget.modelOutputTokens,
        timeout: {
          totalMs: Math.min(input.budget.specialistTimeoutMs, input.budget.totalDeadlineMs),
          firstChunkMs: Math.min(30_000, input.budget.specialistTimeoutMs),
          chunkMs: Math.min(15_000, input.budget.specialistTimeoutMs),
        },
      });
      const decisions = result.output?.decisions ?? [];
      onUsage?.({
        inputCharacters: prompt.length,
        outputCharacters: JSON.stringify(decisions).length,
      });
      return decisions;
    },
  };
}

export async function adjudicateEvidence(
  input: EvidenceAdjudicationInput & { adjudicator?: EvidenceAdjudicator },
): Promise<EvidenceAdjudication[]> {
  if (!input.adjudicator || input.candidates.length === 0) return [];
  const maxCandidatesPerCall = 6;
  // The Article Lens consumes the first model step. Reserve it so the
  // aggregate analysis never exceeds the depth's model-call ceiling.
  const maxAdjudicationCalls = Math.max(0, input.budget.maxModelSteps - 1);
  const decisions: EvidenceAdjudication[] = [];
  for (
    let offset = 0, calls = 0;
    offset < input.candidates.length && calls < maxAdjudicationCalls;
    offset += maxCandidatesPerCall, calls += 1
  ) {
    const batch = input.candidates.slice(offset, offset + maxCandidatesPerCall);
    decisions.push(
      ...(await input.adjudicator.adjudicate({
        ...input,
        candidates: batch,
      })),
    );
  }
  return decisions;
}
