import { randomUUID } from "node:crypto";
import { calculateCompass } from "@perspectica/compass";
import {
  AdditionalContextResultSchema,
  AnalysisEventSchema,
  ArticleDossierSchema,
  EvidenceSectionSchema,
  type AdditionalContextResult,
  type AnalysisEvent,
  type AnalysisMetadata,
  type AnalyzeRequest,
  type ArticleDossier,
  type BiasFinding,
  type BiasResult,
  type CompassEvidence,
  type EvidenceSection,
  type JournalistContextResult,
  type PoliticalContextResult,
  type ReaderCopy,
  type ResearchClaim,
  type ResearchSection,
} from "@perspectica/contracts";
import {
  buildSourceList,
  deduplicateExternalSources,
  validateBiasFindings,
  validateCompassEvidence,
} from "@perspectica/validation";
import { reconcileReaderCopy } from "./reader-copy";

export interface ArticleLensOutput {
  compassEvidence: CompassEvidence[];
  biasCandidates: BiasFinding[];
  dossier?: ArticleDossier;
}

export interface ArticleLensProvider {
  analyze(request: AnalyzeRequest, signal?: AbortSignal): Promise<ArticleLensOutput>;
}

export interface ContextResearchBundle {
  politicalContext: PoliticalContextResult;
  journalistContext: JournalistContextResult;
  failures?: {
    journalistContext?: unknown;
  };
}

export interface EvidenceResearchBundle {
  supporting: EvidenceSection;
  contradicting: EvidenceSection;
  additionalContext: AdditionalContextResult;
  failures?: {
    supporting?: unknown;
    contradicting?: unknown;
    additionalContext?: unknown;
  };
}

export interface ResearchProvider {
  contextBundle(
    request: AnalyzeRequest,
    signal?: AbortSignal,
    brief?: ResearchBrief,
  ): Promise<ContextResearchBundle>;
  evidenceBundle(
    request: AnalyzeRequest,
    claims: ResearchClaim[],
    signal?: AbortSignal,
    brief?: ResearchBrief,
  ): Promise<EvidenceResearchBundle>;
  analyzePoliticalContext?(
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    signal?: AbortSignal,
    articleEvidence?: CompassEvidence[],
  ): Promise<PoliticalContextResult>;
  analyzeJournalistContext?(
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    signal?: AbortSignal,
  ): Promise<JournalistContextResult>;
  analyzeBias?(
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    candidates: BiasFinding[],
    signal?: AbortSignal,
  ): Promise<BiasResult>;
  analyzeEvidence?(
    section: Extract<ResearchSection, "supporting" | "contradicting" | "additional-context">,
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    signal?: AbortSignal,
  ): Promise<EvidenceSection | AdditionalContextResult>;
}

export interface AgenticResearchProvider extends ResearchProvider {
  analyzePoliticalContext(
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    signal?: AbortSignal,
    articleEvidence?: CompassEvidence[],
  ): Promise<PoliticalContextResult>;
  analyzeJournalistContext(
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    signal?: AbortSignal,
  ): Promise<JournalistContextResult>;
  analyzeBias(
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    candidates: BiasFinding[],
    signal?: AbortSignal,
  ): Promise<BiasResult>;
  analyzeEvidence(
    section: Extract<ResearchSection, "supporting" | "contradicting" | "additional-context">,
    request: AnalyzeRequest,
    dossier: ArticleDossier,
    signal?: AbortSignal,
  ): Promise<EvidenceSection | AdditionalContextResult>;
}

export function isAgenticResearchProvider(
  provider: ResearchProvider,
): provider is AgenticResearchProvider {
  const candidate = provider as Partial<AgenticResearchProvider>;
  return (
    typeof candidate.analyzePoliticalContext === "function" &&
    typeof candidate.analyzeJournalistContext === "function" &&
    typeof candidate.analyzeBias === "function" &&
    typeof candidate.analyzeEvidence === "function"
  );
}

/** The small, immutable context shared by each research lane. */
export interface ResearchBrief {
  readonly article: Readonly<{
    title: string;
    author: string | null;
    publication: string | null;
    publishedAt: string | null;
    contentType: AnalyzeRequest["article"]["contentType"];
    canonicalUrl: string;
    domain: string | null;
  }>;
  readonly claims: readonly Readonly<{
    id: string;
    text: string;
    importance: number;
    queryHints: readonly string[];
  }>[];
  readonly queryTerms: string;
  readonly modelContext: string;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trim()}…`
    : normalized;
}

export function createResearchBrief(
  request: AnalyzeRequest,
  claims: ResearchClaim[],
): ResearchBrief {
  let domain: string | null = null;
  try {
    domain = new URL(request.article.canonicalUrl).hostname;
  } catch {
    domain = null;
  }

  const compactClaims = claims
    .slice()
    .sort((left, right) => right.importance - left.importance)
    .slice(0, 4)
    .map((claim) =>
      Object.freeze({
        id: claim.id,
        text: compactText(claim.text, 360),
        importance: claim.importance,
        queryHints: Object.freeze(
          claim.queryHints.slice(0, 1).map((hint) => compactText(hint, 160)),
        ),
      }),
    );

  const article = Object.freeze({
    title: compactText(request.article.title, 240),
    author: request.article.author ? compactText(request.article.author, 160) : null,
    publication: request.article.publication ? compactText(request.article.publication, 160) : null,
    publishedAt: request.article.publishedAt,
    contentType: request.article.contentType,
    canonicalUrl: request.article.canonicalUrl,
    domain,
  });
  const frozenClaims = Object.freeze(compactClaims);
  const queryTerms = compactText(
    compactClaims.map((claim) => claim.queryHints[0] ?? claim.text).join(" "),
    600,
  );

  return Object.freeze({
    article,
    claims: frozenClaims,
    queryTerms,
    modelContext: JSON.stringify({ article, claims: frozenClaims, queryTerms }),
  });
}

const FACTUAL_CLAIM_PATTERN =
  /\b(?:is|are|was|were|has|have|had|will|approved|announced|reported|found|showed|shows|increased|decreased|rose|fell|voted|passed|signed|banned|fired|killed|died|attacked|opened|closed|released|withdrew|walked out|struck|arrested|charged|accused|confirmed|said)\b/i;
const CLAIM_DETAIL_PATTERN =
  /\b(?:\d+(?:\.\d+)?%?|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\b/i;

function sentenceCandidates(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().replace(/\s+/g, " ").slice(0, 360).trim())
    .filter((sentence) => sentence.length >= 35);
}

/**
 * Produces a bounded research seed when structured claim extraction fails.
 * These statements remain exact article sentences and are not presented as
 * verified facts until the research stage evaluates them.
 */
export function extractFallbackClaims(request: AnalyzeRequest, limit = 4): ResearchClaim[] {
  const candidates = request.article.paragraphs
    .filter((paragraph) => paragraph.kind !== "quote")
    .slice(0, 24)
    .flatMap((paragraph) =>
      sentenceCandidates(paragraph.text)
        .filter(
          (sentence) => FACTUAL_CLAIM_PATTERN.test(sentence) || CLAIM_DETAIL_PATTERN.test(sentence),
        )
        .map((sentence) => ({
          paragraphId: paragraph.id,
          paragraphIndex: paragraph.index,
          sentence,
          score:
            Math.max(0, 1 - paragraph.index / 30) +
            (CLAIM_DETAIL_PATTERN.test(sentence) ? 0.25 : 0),
        })),
    )
    .sort((left, right) => right.score - left.score);

  const seen = new Set<string>();
  const selected = candidates.filter((candidate) => {
    const key = candidate.sentence.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (selected.length === 0) {
    const paragraph = request.article.paragraphs.find(
      (candidate) => candidate.kind !== "quote" && candidate.text.trim().length >= 35,
    );
    if (paragraph) {
      selected.push({
        paragraphId: paragraph.id,
        paragraphIndex: paragraph.index,
        sentence: compactText(paragraph.text, 360),
        score: 0.5,
      });
    }
  }

  return selected.slice(0, limit).map((candidate, index) => ({
    id: `fallback-claim-${index + 1}`,
    text: candidate.sentence,
    paragraphIds: [candidate.paragraphId],
    importance: Math.max(0.5, Math.min(1, candidate.score / 1.25)),
    queryHints: [compactText(`${request.article.title} ${candidate.sentence}`, 160)],
  }));
}

export function ensureResearchClaims(
  request: AnalyzeRequest,
  claims: ResearchClaim[],
  limit = 4,
): ResearchClaim[] {
  const accepted = claims.slice(0, limit);
  if (accepted.length >= Math.min(2, limit)) return accepted;

  const seen = new Set(accepted.map((claim) => claim.text.toLocaleLowerCase("en-US")));
  for (const fallback of extractFallbackClaims(request, limit)) {
    if (accepted.length >= limit) break;
    const key = fallback.text.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(fallback);
  }
  return accepted;
}

export function createFallbackDossier(
  request: AnalyzeRequest,
  claims = ensureResearchClaims(request, []),
): ArticleDossier {
  const paragraphById = new Map(
    request.article.paragraphs.map((paragraph) => [paragraph.id, paragraph] as const),
  );
  const passages = claims.slice(0, 4).flatMap((claim) => {
    const paragraph = claim.paragraphIds
      .map((id) => paragraphById.get(id))
      .find((candidate) => candidate !== undefined);
    if (!paragraph) return [];
    return [
      {
        section: "supporting" as const,
        paragraphIds: [paragraph.id],
        text: compactText(paragraph.text, 1_000),
        reason: "This passage contains a central externally checkable claim.",
      },
    ];
  });

  return {
    overview: compactText(
      `${request.article.title}. Research should test the article's central factual claims and framing.`,
      1_000,
    ),
    claims,
    entities: [
      request.article.author,
      request.article.publication,
      ...claims.flatMap((claim) => claim.queryHints.slice(0, 1)),
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .slice(0, 20),
    topics: claims.map((claim) => compactText(claim.text, 160)).slice(0, 8),
    passages,
    researchQuestions: claims.slice(0, 3).flatMap((claim) => [
      {
        section: "supporting" as const,
        question: `What independent source directly confirms: ${compactText(claim.text, 300)}`,
      },
      {
        section: "contradicting" as const,
        question: `Is there a credible correction or material limit to: ${compactText(claim.text, 300)}`,
      },
    ]),
  };
}

export interface AnalysisDependencies {
  articleLens: ArticleLensProvider;
  research: ResearchProvider;
  mode?: "demo" | "live";
  pipelineVersion?: string;
  promptVersion?: string;
  modelVersion?: string;
  reasoningEffort?: AnalysisMetadata["reasoningEffort"];
  now?: () => Date;
  createId?: () => string;
}

function normalizeDossier(
  request: AnalyzeRequest,
  candidate: ArticleDossier | undefined,
): ArticleDossier {
  const parsed = ArticleDossierSchema.safeParse(candidate);
  if (!parsed.success) return createFallbackDossier(request);
  const paragraphById = new Map(
    request.article.paragraphs.map((paragraph) => [paragraph.id, paragraph] as const),
  );
  const claims = ensureResearchClaims(
    request,
    parsed.data.claims
      .map((claim) => ({
        ...claim,
        paragraphIds: claim.paragraphIds.filter((id) => paragraphById.has(id)),
      }))
      .filter((claim) => claim.paragraphIds.length > 0),
    8,
  );
  const passages = parsed.data.passages.filter((passage) =>
    passage.paragraphIds.some((id) => paragraphById.get(id)?.text.includes(passage.text)),
  );
  return ArticleDossierSchema.parse({
    ...parsed.data,
    claims,
    passages,
  });
}

function removeEvidenceUrls<T extends EvidenceSection | AdditionalContextResult>(
  section: T,
  blocked: ReadonlySet<string>,
): T {
  const sources = section.sources.filter((source) => {
    try {
      const url = new URL(source.url);
      url.hash = "";
      return !blocked.has(url.toString());
    } catch {
      return false;
    }
  });
  if (sources.length === section.sources.length) return section;
  return {
    ...section,
    status: sources.length > 0 ? "ready" : "empty",
    sources,
    ...(sources.length === 0
      ? {
          emptyReason: "no-verified-evidence" as const,
          readerCopy: undefined,
        }
      : {}),
  };
}

function finalizeEvidenceResult(
  section: EvidenceSection,
  kind: "supporting" | "contradicting",
): EvidenceSection;
function finalizeEvidenceResult(
  section: AdditionalContextResult,
  kind: "additional-context",
): AdditionalContextResult;
function finalizeEvidenceResult(
  section: EvidenceSection | AdditionalContextResult,
  kind: "supporting" | "contradicting" | "additional-context",
): EvidenceSection | AdditionalContextResult {
  const limit = kind === "additional-context" ? 2 : 3;
  const sources = deduplicateExternalSources(section.sources, limit);
  if (sources.length === 0) {
    const empty = {
      ...section,
      status: "empty" as const,
      sources: [],
      emptyReason: "no-verified-evidence" as const,
      readerCopy: undefined,
    };
    return kind === "additional-context"
      ? AdditionalContextResultSchema.parse(empty)
      : EvidenceSectionSchema.parse(empty);
  }

  const fallbackLead = {
    supporting: "Independent evidence supports important factual claims in the article.",
    contradicting: "Outside evidence adds important limits or corrections to the article’s claims.",
    "additional-context": "This background helps clarify important claims in the article.",
  }[kind];
  const acceptedIds = new Set(sources.map((source) => source.id));
  const readerCopy = section.readerCopy
    ? reconcileReaderCopy(section.readerCopy, acceptedIds, {
        fallbackLead,
        fallbackFindings: sources.map((source) => ({
          id: `reader-${source.id}`,
          text: source.relationshipExplanation,
          citationId: source.id,
          keySourceNote: source.publicationContext,
        })),
      })
    : undefined;
  const ready = {
    ...section,
    status: "ready" as const,
    sources,
    ...(readerCopy ? { readerCopy } : {}),
  };
  return kind === "additional-context"
    ? AdditionalContextResultSchema.parse(ready)
    : EvidenceSectionSchema.parse(ready);
}

function evidenceUrlSet(section: EvidenceSection | AdditionalContextResult): Set<string> {
  return new Set(
    section.sources.flatMap((source) => {
      try {
        const url = new URL(source.url);
        url.hash = "";
        return [url.toString()];
      } catch {
        return [];
      }
    }),
  );
}

type AgenticTaskKind =
  | "lens"
  | "political"
  | "journalist"
  | "bias"
  | "supporting"
  | "contradicting"
  | "additional-context";

interface AgenticTaskCompletion {
  kind: AgenticTaskKind;
  settlement: TaskSettlement<unknown>;
}

async function* runAgenticResearchPipeline(
  request: AnalyzeRequest,
  dependencies: AnalysisDependencies & { research: AgenticResearchProvider },
  analysisId: string,
  startedAt: Date,
  now: () => Date,
  signal?: AbortSignal,
): AsyncGenerator<AnalysisEvent> {
  const fallbackDossier = createFallbackDossier(request);
  const tasks = new Map<AgenticTaskKind, Promise<AgenticTaskCompletion>>();
  const startTask = <T>(kind: AgenticTaskKind, invoke: () => Promise<T>) => {
    tasks.set(
      kind,
      settle(invoke).then((settlement): AgenticTaskCompletion => ({ kind, settlement })),
    );
  };
  startTask("lens", () => dependencies.articleLens.analyze(request, signal));
  startTask("journalist", () =>
    dependencies.research.analyzeJournalistContext(request, fallbackDossier, signal),
  );

  let lensResolved = false;
  let compassEvidence: CompassEvidence[] = [];
  let political: TaskSettlement<PoliticalContextResult> | null = null;
  let provisionalCompassEmitted = false;
  let finalCompassEmitted = false;
  const failedSections = new Set<
    | "compass"
    | "bias"
    | "journalist-context"
    | "supporting"
    | "contradicting"
    | "additional-context"
  >();
  const evidenceResults: Partial<{
    supporting: EvidenceSection;
    contradicting: EvidenceSection;
    "additional-context": AdditionalContextResult;
  }> = {};
  const evidenceErrors: Partial<
    Record<"supporting" | "contradicting" | "additional-context", unknown>
  > = {};
  let evidenceRemaining = 3;
  let evidenceEmitted = false;

  while (tasks.size > 0) {
    const completed = await Promise.race(tasks.values());
    tasks.delete(completed.kind);
    throwIfAborted(signal);

    if (completed.kind === "lens") {
      lensResolved = true;
      let dossier = fallbackDossier;
      let candidates: BiasFinding[] = [];
      if (!completed.settlement.ok) {
        failedSections.add("compass");
        yield sectionFailure("compass", analysisId, completed.settlement.error, now);
      } else {
        const lens = completed.settlement.data as ArticleLensOutput;
        dossier = normalizeDossier(request, lens.dossier);
        candidates = lens.biasCandidates;
        try {
          compassEvidence = validateCompassEvidence(request.article, lens.compassEvidence);
          // The spectrum specialist receives validated article evidence. This
          // makes its 40–60% article/context weighting a real judgment over
          // the current article, not a publication-only prior.
          startTask("political", () =>
            dependencies.research.analyzePoliticalContext(
              request,
              dossier,
              signal,
              compassEvidence,
            ),
          );
          const context = political?.ok === true ? political.data : undefined;
          const compass = calculateCompass(compassEvidence, {
            ...(context ? { context } : {}),
            publication: request.article.publication,
          });
          if (political) {
            finalCompassEmitted = true;
            yield createEvent("compass.ready", analysisId, compass, now);
          } else if (compass.basis !== "calibrated-fallback") {
            // Do not show the last-resort calibration while the multi-pass
            // publication and journalist research lane is still running.
            provisionalCompassEmitted = true;
            yield createEvent("compass.provisional", analysisId, compass, now);
          }
        } catch (error) {
          failedSections.add("compass");
          yield sectionFailure("compass", analysisId, error, now);
        }
      }

      startTask("bias", () =>
        dependencies.research.analyzeBias(request, dossier, candidates, signal),
      );
      startTask("supporting", () =>
        dependencies.research.analyzeEvidence("supporting", request, dossier, signal),
      );
      startTask("contradicting", () =>
        dependencies.research.analyzeEvidence("contradicting", request, dossier, signal),
      );
      startTask("additional-context", () =>
        dependencies.research.analyzeEvidence("additional-context", request, dossier, signal),
      );
      continue;
    }

    if (completed.kind === "political") {
      political = completed.settlement as TaskSettlement<PoliticalContextResult>;
      if (lensResolved && !finalCompassEmitted && !failedSections.has("compass")) {
        const context = political.ok ? political.data : undefined;
        finalCompassEmitted = true;
        yield createEvent(
          "compass.ready",
          analysisId,
          calculateCompass(compassEvidence, {
            ...(context ? { context } : {}),
            publication: request.article.publication,
          }),
          now,
        );
      }
      continue;
    }

    if (completed.kind === "journalist") {
      if (!completed.settlement.ok) {
        failedSections.add("journalist-context");
        yield sectionFailure("journalist-context", analysisId, completed.settlement.error, now);
      } else {
        yield createEvent("journalistContext.ready", analysisId, completed.settlement.data, now);
      }
      continue;
    }

    if (completed.kind === "bias") {
      if (!completed.settlement.ok) {
        failedSections.add("bias");
        yield sectionFailure("bias", analysisId, completed.settlement.error, now);
      } else {
        try {
          const agentBias = completed.settlement.data as BiasResult;
          const validated = validateBiasFindings(request.article, agentBias.findings);
          const acceptedBiasIds = new Set(validated.findings.map((finding) => finding.id));
          const readerCopy: ReaderCopy | undefined =
            validated.status === "ready" && agentBias.readerCopy
              ? reconcileReaderCopy(agentBias.readerCopy, acceptedBiasIds, {
                  fallbackLead:
                    "The article includes a framing choice that may shape how the story is read.",
                  fallbackFindings: validated.findings.map((finding) => ({
                    id: `reader-${finding.id}`,
                    text: finding.explanation,
                    citationId: finding.id,
                  })),
                })
              : undefined;
          yield createEvent(
            "bias.ready",
            analysisId,
            {
              ...validated,
              summary:
                validated.status === "ready"
                  ? agentBias.summary
                  : "No meaningful framing pattern stood out in this article.",
              ...(readerCopy ? { readerCopy } : {}),
              citations: agentBias.citations ?? [],
            },
            now,
          );
        } catch (error) {
          failedSections.add("bias");
          yield sectionFailure("bias", analysisId, error, now);
        }
      }
      continue;
    }

    evidenceRemaining -= 1;
    const evidenceKind = completed.kind as "supporting" | "contradicting" | "additional-context";
    if (completed.settlement.ok) {
      if (evidenceKind === "additional-context") {
        evidenceResults[evidenceKind] = completed.settlement.data as AdditionalContextResult;
      } else {
        evidenceResults[evidenceKind] = completed.settlement.data as EvidenceSection;
      }
    } else {
      evidenceErrors[evidenceKind] = completed.settlement.error;
    }

    if (evidenceRemaining === 0 && !evidenceEmitted) {
      evidenceEmitted = true;
      const contradicting = evidenceResults.contradicting;
      const supporting = evidenceResults.supporting;
      const additionalContext = evidenceResults["additional-context"];
      const contradictionUrls = contradicting ? evidenceUrlSet(contradicting) : new Set<string>();
      const exclusiveSupporting = supporting
        ? removeEvidenceUrls(supporting, contradictionUrls)
        : undefined;
      const usedEvidenceUrls = new Set([
        ...contradictionUrls,
        ...(exclusiveSupporting ? evidenceUrlSet(exclusiveSupporting) : []),
      ]);
      const exclusiveContext = additionalContext
        ? removeEvidenceUrls(additionalContext, usedEvidenceUrls)
        : undefined;
      const finalSupporting = exclusiveSupporting
        ? finalizeEvidenceResult(exclusiveSupporting, "supporting")
        : undefined;
      const finalContradicting = contradicting
        ? finalizeEvidenceResult(contradicting, "contradicting")
        : undefined;
      const finalContext = exclusiveContext
        ? finalizeEvidenceResult(exclusiveContext, "additional-context")
        : undefined;

      for (const section of ["supporting", "contradicting", "additional-context"] as const) {
        const error = evidenceErrors[section];
        if (error) {
          failedSections.add(section);
          yield sectionFailure(section, analysisId, error, now);
          continue;
        }
        if (section === "supporting" && finalSupporting) {
          yield createEvent("supporting.ready", analysisId, finalSupporting, now);
        } else if (section === "contradicting" && finalContradicting) {
          yield createEvent("contradicting.ready", analysisId, finalContradicting, now);
        } else if (section === "additional-context" && finalContext) {
          yield createEvent("additionalContext.ready", analysisId, finalContext, now);
        }
      }
    }
  }

  if (provisionalCompassEmitted && !finalCompassEmitted && !failedSections.has("compass")) {
    yield createEvent(
      "compass.ready",
      analysisId,
      calculateCompass(compassEvidence, { publication: request.article.publication }),
      now,
    );
  }

  const completedAt = now();
  yield createEvent(
    "analysis.completed",
    analysisId,
    {
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.valueOf() - startedAt.valueOf()),
      status: failedSections.size > 0 ? "partial" : "complete",
      failedSections: [...failedSections],
    },
    now,
  );
}

function createEvent(
  type: AnalysisEvent["type"],
  analysisId: string,
  data: unknown,
  now: () => Date,
): AnalysisEvent {
  return AnalysisEventSchema.parse({
    type,
    analysisId,
    emittedAt: now().toISOString(),
    data,
  });
}

function sectionFailure(
  section:
    | "compass"
    | "bias"
    | "journalist-context"
    | "supporting"
    | "contradicting"
    | "additional-context",
  analysisId: string,
  error: unknown,
  now: () => Date,
): AnalysisEvent {
  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const timedOut = /(?:time(?:d|out)|aborted)/i.test(rawMessage);
  const message = timedOut
    ? "This section took longer than expected. Try again."
    : "This section could not be completed. Try again.";

  return createEvent(
    "section.failed",
    analysisId,
    {
      section,
      message,
      retryable: true,
    },
    now,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Analysis aborted", "AbortError");
  }
}

type TaskSettlement<T> = { ok: true; data: T } | { ok: false; error: unknown };

function safePromise<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(invoke());
  } catch (error) {
    return Promise.reject(error);
  }
}

function settle<T>(invoke: () => Promise<T>): Promise<TaskSettlement<T>> {
  return safePromise(invoke).then(
    (data): TaskSettlement<T> => ({ ok: true, data }),
    (error: unknown): TaskSettlement<T> => ({ ok: false, error }),
  );
}

export async function* runAnalysis(
  request: AnalyzeRequest,
  dependencies: AnalysisDependencies,
  signal?: AbortSignal,
): AsyncGenerator<AnalysisEvent> {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const analysisId = createId();
  const startedAt = now();
  const metadata: AnalysisMetadata = {
    analysisId,
    articleFingerprint: request.article.fingerprint,
    mode: dependencies.mode ?? "demo",
    pipelineVersion: dependencies.pipelineVersion ?? "2026-07-28.1",
    promptVersion: dependencies.promptVersion ?? "article-lens-v1",
    modelVersion: dependencies.modelVersion ?? "demo-v1",
    reasoningEffort: dependencies.reasoningEffort ?? "none",
    startedAt: startedAt.toISOString(),
    contentType: request.article.contentType,
  };

  yield createEvent("analysis.started", analysisId, metadata, now);
  yield createEvent(
    "metadata.ready",
    analysisId,
    {
      title: request.article.title,
      author: request.article.author,
      publication: request.article.publication,
      publishedAt: request.article.publishedAt,
      contentType: request.article.contentType,
    },
    now,
  );
  yield createEvent("sourceList.ready", analysisId, buildSourceList(request.article), now);

  throwIfAborted(signal);
  if (isAgenticResearchProvider(dependencies.research)) {
    yield* runAgenticResearchPipeline(
      request,
      { ...dependencies, research: dependencies.research },
      analysisId,
      startedAt,
      now,
      signal,
    );
    return;
  }

  // Research starts from exact article sentences rather than waiting for the
  // model to generate search claims. This keeps the three expensive stages
  // independent and prevents an Article Lens timeout from delaying evidence.
  const claims = ensureResearchClaims(request, []);
  const initialResearchBrief = createResearchBrief(request, claims);
  const contextTask = settle(() =>
    dependencies.research.contextBundle(request, signal, initialResearchBrief),
  );
  const lensTask = settle(() => dependencies.articleLens.analyze(request, signal));
  const evidenceTask = settle(() =>
    dependencies.research.evidenceBundle(request, claims, signal, initialResearchBrief),
  );
  let contextSettlement: Awaited<typeof contextTask> | null = null;
  let contextPending = true;
  let lensPending = true;
  let evidencePending = true;
  let provisionalCompassEmitted = false;
  let compassEvidence: CompassEvidence[] = [];
  let articleCompass: ReturnType<typeof calculateCompass> | null = null;
  const failedSections = new Set<
    | "compass"
    | "bias"
    | "journalist-context"
    | "supporting"
    | "contradicting"
    | "additional-context"
  >();

  while (lensPending || contextPending || evidencePending) {
    const pending: Array<
      Promise<
        | { kind: "lens"; settlement: Awaited<typeof lensTask> }
        | { kind: "context"; settlement: Awaited<typeof contextTask> }
        | { kind: "evidence"; settlement: Awaited<typeof evidenceTask> }
      >
    > = [];
    if (lensPending) {
      pending.push(lensTask.then((settlement) => ({ kind: "lens" as const, settlement })));
    }
    if (contextPending) {
      pending.push(contextTask.then((settlement) => ({ kind: "context" as const, settlement })));
    }
    if (evidencePending) {
      pending.push(evidenceTask.then((settlement) => ({ kind: "evidence" as const, settlement })));
    }
    const completed = await Promise.race(pending);
    throwIfAborted(signal);

    if (completed.kind === "lens") {
      lensPending = false;
      if (!completed.settlement.ok) {
        failedSections.add("compass");
        failedSections.add("bias");
        yield sectionFailure("compass", analysisId, completed.settlement.error, now);
        yield sectionFailure("bias", analysisId, completed.settlement.error, now);
        continue;
      }

      try {
        compassEvidence = validateCompassEvidence(
          request.article,
          completed.settlement.data.compassEvidence,
        );
        articleCompass = calculateCompass(compassEvidence, {
          publication: request.article.publication,
        });
      } catch (error) {
        failedSections.add("compass");
        yield sectionFailure("compass", analysisId, error, now);
      }

      try {
        const bias = validateBiasFindings(
          request.article,
          completed.settlement.data.biasCandidates,
        );
        yield createEvent("bias.ready", analysisId, bias, now);
      } catch (error) {
        failedSections.add("bias");
        yield sectionFailure("bias", analysisId, error, now);
      }

      if (articleCompass) {
        if (!contextPending) {
          const context =
            contextSettlement?.ok === true ? contextSettlement.data.politicalContext : undefined;
          yield createEvent(
            "compass.ready",
            analysisId,
            calculateCompass(compassEvidence, {
              ...(context ? { context } : {}),
              publication: request.article.publication,
            }),
            now,
          );
        } else if (articleCompass.basis !== "calibrated-fallback") {
          provisionalCompassEmitted = true;
          yield createEvent("compass.provisional", analysisId, articleCompass, now);
        }
      }
      continue;
    }

    if (completed.kind === "context") {
      contextPending = false;
      contextSettlement = completed.settlement;
      if (contextSettlement.ok) {
        if (contextSettlement.data.failures?.journalistContext) {
          failedSections.add("journalist-context");
          yield sectionFailure(
            "journalist-context",
            analysisId,
            contextSettlement.data.failures.journalistContext,
            now,
          );
        } else {
          yield createEvent(
            "journalistContext.ready",
            analysisId,
            {
              ...contextSettlement.data.journalistContext,
              findings: contextSettlement.data.journalistContext.findings.slice(0, 2),
            },
            now,
          );
        }
      } else {
        failedSections.add("journalist-context");
        yield sectionFailure("journalist-context", analysisId, contextSettlement.error, now);
      }

      if (
        !lensPending &&
        articleCompass &&
        (provisionalCompassEmitted || articleCompass.basis === "calibrated-fallback")
      ) {
        const context = contextSettlement.ok ? contextSettlement.data.politicalContext : undefined;
        yield createEvent(
          "compass.ready",
          analysisId,
          calculateCompass(compassEvidence, {
            ...(context ? { context } : {}),
            publication: request.article.publication,
          }),
          now,
        );
      }
      continue;
    }

    evidencePending = false;
    if (!completed.settlement.ok) {
      for (const section of ["supporting", "contradicting", "additional-context"] as const) {
        failedSections.add(section);
        yield sectionFailure(section, analysisId, completed.settlement.error, now);
      }
      continue;
    }

    const evidence = completed.settlement.data;
    if (evidence.failures?.supporting) {
      failedSections.add("supporting");
      yield sectionFailure("supporting", analysisId, evidence.failures.supporting, now);
    } else {
      yield createEvent(
        "supporting.ready",
        analysisId,
        {
          ...evidence.supporting,
          sources: deduplicateExternalSources(evidence.supporting.sources, 2),
        },
        now,
      );
    }
    if (evidence.failures?.contradicting) {
      failedSections.add("contradicting");
      yield sectionFailure("contradicting", analysisId, evidence.failures.contradicting, now);
    } else {
      yield createEvent(
        "contradicting.ready",
        analysisId,
        {
          ...evidence.contradicting,
          sources: deduplicateExternalSources(evidence.contradicting.sources, 2),
        },
        now,
      );
    }
    if (evidence.failures?.additionalContext) {
      failedSections.add("additional-context");
      yield sectionFailure(
        "additional-context",
        analysisId,
        evidence.failures.additionalContext,
        now,
      );
    } else {
      yield createEvent(
        "additionalContext.ready",
        analysisId,
        {
          ...evidence.additionalContext,
          sources: deduplicateExternalSources(evidence.additionalContext.sources, 1),
        },
        now,
      );
    }
  }

  const completedAt = now();
  yield createEvent(
    "analysis.completed",
    analysisId,
    {
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.valueOf() - startedAt.valueOf()),
      status: failedSections.size > 0 ? "partial" : "complete",
      failedSections: [...failedSections],
    },
    now,
  );
}
