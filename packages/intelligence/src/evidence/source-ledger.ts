import {
  SourceLedgerSnapshotSchema,
  type EvidenceAssertion,
  type EvidenceBatch,
  type SourceLedgerSnapshot,
  type SourceRecord,
} from "@perspectica/contracts/evidence";
import { MAX_EVIDENCE_ASSERTIONS } from "@perspectica/contracts/limits";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import type { ArticleIndex } from "@perspectica/contracts/article";
import type { AnalysisBudget } from "../budgets";
import { assertionIdFor, contentSignature, normalizeCanonicalUrl } from "./normalization";
import { buildEvidenceGraph } from "./evidence-graph";
import { validateEvidenceCard, mergeSource } from "./validation";
import { evaluateSufficiency } from "./sufficiency";

export interface LedgerAcceptResult {
  acceptedSources: number;
  acceptedAssertions: number;
  rejected: number;
  reasons: string[];
}

export class EvidenceLedger {
  private readonly sources = new Map<string, SourceRecord>();
  private readonly assertions = new Map<string, EvidenceAssertion>();
  private readonly completedMissions = new Set<string>();
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
    if (snapshot.completedMissionIds.length === 0) {
      for (const assertion of snapshot.assertions)
        ledger.completedMissions.add(assertion.missionId);
    }
    return ledger;
  }

  accept(batch: EvidenceBatch): LedgerAcceptResult {
    let acceptedSources = 0;
    let acceptedAssertions = 0;
    let rejected = 0;
    for (const card of batch.cards) {
      const validation = validateEvidenceCard(card, this.article.meta.canonicalUrl);
      if (!validation.accepted || !validation.canonicalUrl) {
        rejected += 1;
        this.rejectedReasons.push(validation.reason);
        continue;
      }
      // Canonical URL is the source identity. Provider is provenance metadata,
      // not a reason to duplicate one URL in the graph.
      const sourceId = `source-${contentSignature(validation.canonicalUrl).slice(-8)}`;
      const source: SourceRecord = {
        id: sourceId,
        canonicalUrl: validation.canonicalUrl,
        title: card.title,
        publication: card.publication,
        publishedAt: card.publishedAt,
        sourceType: card.sourceType,
        contentKind: card.contentKind,
        content: card.content,
        contentSignature: contentSignature(card.content),
        retrievedAt: new Date().toISOString(),
        provider: card.provider,
      };
      const previous = this.sources.get(sourceId);
      if (!previous && this.sources.size >= this.budget.maxSources) continue;
      if (!previous) acceptedSources += 1;
      this.sources.set(sourceId, mergeSource(previous, source));
      if (this.assertions.size >= MAX_EVIDENCE_ASSERTIONS) continue;
      const assertionId = assertionIdFor(sourceId, card.missionId, card.statement);
      if (this.assertions.has(assertionId)) continue;
      const assertion: EvidenceAssertion = {
        id: assertionId,
        sourceId,
        missionId: card.missionId,
        claimId: card.claimId,
        relationship: card.relationship,
        statement: card.statement,
        excerpt: card.contentKind === "source-text" ? card.excerpt : null,
        articleParagraphIds: card.claimId
          ? (this.plan.claims.find((claim) => claim.id === card.claimId)?.paragraphIds ?? [])
          : [],
        confidence: card.confidence,
        validation: {
          accepted: true,
          provenance: "verified-url",
          excerptMatches: validation.excerptMatches,
          reason: validation.reason,
        },
      };
      this.assertions.set(assertionId, assertion);
      acceptedAssertions += 1;
    }
    this.completedMissions.add(batch.missionId);
    return {
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
      this.completedMissions.size,
      this.budget,
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
    for (const mission of this.plan.missions) {
      const missionAssertions = assertions
        .filter((assertion) => assertion.missionId === mission.id)
        .map((assertion) => assertion.id);
      for (const section of mission.canServeSections) {
        servedSections[section] = [...(servedSections[section] ?? []), ...missionAssertions].slice(
          0,
          32,
        );
      }
    }
    return SourceLedgerSnapshotSchema.parse({
      sources,
      assertions,
      graph: buildEvidenceGraph(this.plan, sources, assertions),
      sufficiency,
      servedSections,
      completedMissionIds: [...this.completedMissions],
    });
  }

  getSources(): SourceRecord[] {
    return [...this.sources.values()];
  }
  getAssertions(): EvidenceAssertion[] {
    return [...this.assertions.values()];
  }
  completedMissionCount(): number {
    return this.completedMissions.size;
  }
  isSufficient(): boolean {
    return this.snapshot().sufficiency.stop;
  }
  hasEvidenceForClaim(claimId: string): boolean {
    return this.getAssertions().some((assertion) => assertion.claimId === claimId);
  }
  articleLinkSource(url: string): boolean {
    return normalizeCanonicalUrl(url) === normalizeCanonicalUrl(this.article.meta.canonicalUrl);
  }
}
