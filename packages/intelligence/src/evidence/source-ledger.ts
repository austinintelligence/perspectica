import {
  SourceLedgerSnapshotSchema,
  type EvidenceAdjudication,
  type EvidenceAssertion,
  type EvidenceBatch,
  type EvidenceCandidate,
  type SourceLedgerSnapshot,
  type SourceRecord,
} from "@perspectica/contracts/evidence";
import { MAX_EVIDENCE_ASSERTIONS } from "@perspectica/contracts/limits";
import type { AnalysisPlan, ReportSection } from "@perspectica/contracts/report";
import type { ArticleIndex } from "@perspectica/contracts/article";
import type { AnalysisBudget } from "../budgets";
import {
  assertionIdFor,
  contentSignature,
  normalizeCanonicalUrl,
  sourceIdFor,
} from "./normalization";
import { buildEvidenceGraph } from "./evidence-graph";
import { mergeSource, validateEvidenceAdjudication } from "./validation";
import { evaluateSufficiency } from "./sufficiency";

export interface LedgerAcceptResult {
  acceptedCandidates: number;
  acceptedSources: number;
  acceptedAssertions: number;
  rejected: number;
  reasons: string[];
}

export class EvidenceLedger {
  private readonly candidates = new Map<string, EvidenceCandidate>();
  private readonly sources = new Map<string, SourceRecord>();
  private readonly assertions = new Map<string, EvidenceAssertion>();
  private readonly completedMissions = new Set<string>();
  private readonly failedMissions = new Set<string>();
  private readonly rejectedReasons: string[] = [];

  constructor(
    readonly article: ArticleIndex,
    readonly plan: AnalysisPlan,
    readonly budget: AnalysisBudget,
  ) {}

  static fromSnapshot(
    article: ArticleIndex,
    plan: AnalysisPlan,
    budget: AnalysisBudget,
    snapshot: SourceLedgerSnapshot,
  ): EvidenceLedger {
    const ledger = new EvidenceLedger(article, plan, budget);
    for (const source of snapshot.sources) ledger.sources.set(source.id, source);
    for (const assertion of snapshot.assertions) ledger.assertions.set(assertion.id, assertion);
    for (const missionId of snapshot.completedMissionIds) ledger.completedMissions.add(missionId);
    for (const missionId of snapshot.failedMissionIds) ledger.failedMissions.add(missionId);
    if (snapshot.completedMissionIds.length === 0 && snapshot.failedMissionIds.length === 0) {
      for (const assertion of snapshot.assertions)
        ledger.completedMissions.add(assertion.missionId);
    }
    return ledger;
  }

  /** Store provider discovery without allowing it to become reader evidence. */
  accept(batch: EvidenceBatch): LedgerAcceptResult {
    let acceptedCandidates = 0;
    const maxCandidates = Math.max(24, this.budget.maxSources * 4);
    for (const candidate of batch.candidates) {
      if (!this.candidates.has(candidate.id)) {
        if (this.candidates.size >= maxCandidates) continue;
        this.candidates.set(candidate.id, candidate);
        acceptedCandidates += 1;
      }
    }
    const plannedMissionIds = new Set(this.plan.missions.map((mission) => mission.id));
    const coveredMissionIds = (
      batch.coveredMissionIds.length > 0 ? batch.coveredMissionIds : [batch.missionId]
    ).filter((missionId) => plannedMissionIds.has(missionId));
    if (batch.status === "failed") {
      for (const missionId of coveredMissionIds) this.failedMissions.add(missionId);
    } else {
      for (const missionId of coveredMissionIds) {
        this.completedMissions.add(missionId);
        this.failedMissions.delete(missionId);
      }
    }
    if (batch.error) this.rejectedReasons.push(batch.error);
    return {
      acceptedCandidates,
      acceptedSources: this.sources.size,
      acceptedAssertions: this.assertions.size,
      rejected: batch.candidates.length - acceptedCandidates,
      reasons: this.rejectedReasons.slice(-8),
    };
  }

  markMissionsFailed(missionIds: readonly string[], reason: string): void {
    const planned = new Set(this.plan.missions.map((mission) => mission.id));
    for (const missionId of missionIds) {
      if (!planned.has(missionId)) continue;
      this.completedMissions.delete(missionId);
      this.failedMissions.add(missionId);
    }
    const message = reason.trim();
    if (message) this.rejectedReasons.push(message.slice(0, 500));
  }

  /**
   * Accept only decisions produced by the bounded adjudicator. Every source
   * identity and reader-facing assertion is reconstructed from the candidate
   * and the validated decision rather than copied from a provider card.
   */
  acceptAdjudications(decisions: readonly EvidenceAdjudication[]): LedgerAcceptResult {
    let acceptedSources = 0;
    let acceptedAssertions = 0;
    let rejected = 0;
    for (const decision of decisions) {
      const candidate = this.candidates.get(decision.candidateId);
      if (!candidate) {
        rejected += 1;
        this.rejectedReasons.push("The adjudicator referenced a candidate that was not retrieved.");
        continue;
      }
      const validation = validateEvidenceAdjudication(decision, candidate, this.article, this.plan);
      if (!validation.accepted || !validation.canonicalUrl) {
        rejected += 1;
        this.rejectedReasons.push(validation.reason);
        continue;
      }
      const sourceId = sourceIdFor(validation.canonicalUrl);
      const source: SourceRecord = {
        id: sourceId,
        canonicalUrl: validation.canonicalUrl,
        title: candidate.title,
        publication: candidate.publication,
        publishedAt: candidate.publishedAt,
        sourceType: candidate.sourceType,
        contentKind: candidate.contentKind,
        content: candidate.content,
        contentSignature: contentSignature(candidate.content),
        retrievedAt: new Date().toISOString(),
        provider: candidate.provider,
      };
      const previous = this.sources.get(sourceId);
      if (!previous && this.sources.size >= this.budget.maxSources) continue;
      if (!previous) acceptedSources += 1;
      this.sources.set(sourceId, mergeSource(previous, source));
      if (this.assertions.size >= MAX_EVIDENCE_ASSERTIONS) continue;
      const assertionId = assertionIdFor(sourceId, decision.missionId, decision.statement);
      if (this.assertions.has(assertionId)) continue;
      const claim = decision.claimId
        ? this.plan.claims.find((value) => value.id === decision.claimId)
        : undefined;
      this.assertions.set(assertionId, {
        id: assertionId,
        sourceId,
        missionId: decision.missionId,
        claimId: decision.claimId,
        relationship: decision.relationship,
        statement: decision.statement,
        excerpt: candidate.contentKind === "source-text" ? decision.excerpt : null,
        articleParagraphIds: claim?.paragraphIds ?? [],
        confidence: Math.min(decision.confidence, decision.relevance),
        validation,
        context: decision.context,
      });
      acceptedAssertions += 1;
    }
    return {
      acceptedCandidates: this.candidates.size,
      acceptedSources,
      acceptedAssertions,
      rejected,
      reasons: this.rejectedReasons.slice(-8),
    };
  }

  snapshot(): SourceLedgerSnapshot {
    const assertions = [...this.assertions.values()];
    const sources = [...this.sources.values()];
    const sufficiency = evaluateSufficiency(
      this.plan,
      assertions,
      this.completedMissionCount(),
      this.budget,
      this.candidates.size,
    );
    const servedSections: Record<string, string[]> = {
      compass: [],
      bias: [],
      "journalist-context": [],
      supporting: [],
      contradicting: [],
      "additional-context": [],
      "works-cited": [],
    };
    for (const assertion of assertions) {
      const mission = this.plan.missions.find((value) => value.id === assertion.missionId);
      if (!mission) continue;
      for (const section of mission.canServeSections) {
        servedSections[section] = [...(servedSections[section] ?? []), assertion.id].slice(0, 32);
      }
    }
    return SourceLedgerSnapshotSchema.parse({
      sources,
      assertions,
      graph: buildEvidenceGraph(this.plan, sources, assertions),
      sufficiency,
      servedSections,
      completedMissionIds: [...this.completedMissions],
      failedMissionIds: [...this.failedMissions],
    });
  }

  getCandidates(): EvidenceCandidate[] {
    return [...this.candidates.values()];
  }
  getSources(): SourceRecord[] {
    return [...this.sources.values()];
  }
  getAssertions(): EvidenceAssertion[] {
    return [...this.assertions.values()];
  }
  completedMissionCount(): number {
    return new Set([...this.completedMissions, ...this.failedMissions]).size;
  }
  failedMissionIds(): string[] {
    return [...this.failedMissions];
  }
  isMissionFailed(missionId: string): boolean {
    return this.failedMissions.has(missionId);
  }
  isSufficient(): boolean {
    return this.snapshot().sufficiency.stop;
  }
  hasEvidenceForClaim(claimId: string): boolean {
    return this.getAssertions().some((assertion) => assertion.claimId === claimId);
  }
  hasEvidenceForSection(section: ReportSection): boolean {
    return this.snapshot().servedSections[section]?.length > 0;
  }
  articleLinkSource(url: string): boolean {
    return normalizeCanonicalUrl(url) === normalizeCanonicalUrl(this.article.meta.canonicalUrl);
  }
}
