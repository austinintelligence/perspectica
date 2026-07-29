import type {
  AnalyzeRequest,
  BiasFinding,
  BiasTechnique,
  CompassDirection,
  CompassEvidence,
  ResearchClaim,
} from "@perspectica/contracts";
import type { ArticleLensOutput, ArticleLensProvider, ResearchProvider } from "./index";

interface PoliticalPattern {
  direction: CompassDirection;
  score: number;
  pattern: RegExp;
  explanation: string;
}

const politicalPatterns: PoliticalPattern[] = [
  {
    direction: "left",
    score: -1,
    pattern:
      /\b(public housing|welfare|redistribut|social equality|equal access|public investment|worker protections?|higher taxes?|universal (?:care|benefit))\b/i,
    explanation:
      "The passage favors collective provision or a more equal distribution of resources.",
  },
  {
    direction: "right",
    score: 1,
    pattern:
      /\b(free market|market-driven|tax cuts?|deregulat|private ownership|private sector|competition|individual responsibility)\b/i,
    explanation: "The passage favors market allocation, private ownership, or economic autonomy.",
  },
  {
    direction: "right",
    score: 0.8,
    pattern:
      /\b(crackdown|mandatory|ban(?:ned)?|executive power|law and order|strict enforcement|punishment|central authority|hierarch)\b/i,
    explanation:
      "The passage favors stronger authority, enforcement, or hierarchical decision-making.",
  },
  {
    direction: "left",
    score: -0.8,
    pattern:
      /\b(local participation|civil liberties|personal decisions?|decentrali[sz]|community vote|individual rights?|personal freedom|grassroots)\b/i,
    explanation: "The passage favors decentralized participation or personal self-determination.",
  },
];

const biasPatterns: Array<{
  technique: BiasTechnique;
  displayName: string;
  pattern: RegExp;
  explanation: string;
}> = [
  {
    technique: "emotional-sensationalism",
    displayName: "Emotional sensationalism",
    pattern:
      /\b(urgent(?:ly)?|crisis|disaster|shocking|sweeping|dangerous|radical|hordes|chaos|devastating)\b/i,
    explanation:
      "The passage uses emotionally intense language that can increase urgency or alarm.",
  },
  {
    technique: "speculation",
    displayName: "Speculation",
    pattern: /\b(may|might|could|likely|appears?|seems?|perhaps|reportedly)\b/i,
    explanation:
      "The passage advances a possibility or interpretation while the underlying facts remain uncertain.",
  },
  {
    technique: "false-dichotomy",
    displayName: "False dichotomy",
    pattern: /\beither\b.{0,180}\bor\b/i,
    explanation: "The passage frames the situation as a narrow choice between two possibilities.",
  },
  {
    technique: "generalization",
    displayName: "Generalization",
    pattern: /\b(everyone|always|never|nobody|all (?:voters|people|officials|experts))\b/i,
    explanation:
      "The passage applies a broad claim to a group or situation with limited qualification.",
  },
  {
    technique: "word-choice",
    displayName: "Loaded word choice",
    pattern: /\b(slammed|admitted|claimed|regime|mob|elite|extremist|so-called)\b/i,
    explanation:
      "The selected wording carries a positive or negative judgment beyond a neutral description.",
  },
];

export class DemoArticleLensProvider implements ArticleLensProvider {
  async analyze(request: AnalyzeRequest, signal?: AbortSignal): Promise<ArticleLensOutput> {
    signal?.throwIfAborted();
    const compassEvidence: CompassEvidence[] = [];
    const biasCandidates: BiasFinding[] = [];

    for (const paragraph of request.article.paragraphs) {
      for (const political of politicalPatterns) {
        if (!political.pattern.test(paragraph.text)) continue;
        compassEvidence.push({
          id: `compass-${compassEvidence.length + 1}`,
          paragraphId: paragraph.id,
          excerpt: paragraph.text,
          speaker: paragraph.speaker ?? null,
          endorsedByArticle: paragraph.kind !== "quote",
          score: political.score,
          direction: political.direction,
          strength: paragraph.kind === "heading" ? 0.65 : 0.8,
          relevance: 0.8,
          explanation: political.explanation,
        });
      }

      for (const bias of biasPatterns) {
        if (!bias.pattern.test(paragraph.text)) continue;
        biasCandidates.push({
          id: `bias-${biasCandidates.length + 1}`,
          technique: bias.technique,
          displayName: bias.displayName,
          paragraphId: paragraph.id,
          excerpt: paragraph.text,
          explanation: bias.explanation,
          confidence: 0.68,
          relevance: paragraph.kind === "heading" ? 0.9 : 0.75,
          prominence: Math.max(0.4, 1 - paragraph.index / 30),
        });
      }
    }

    return {
      compassEvidence: compassEvidence.slice(0, 12),
      biasCandidates: biasCandidates.slice(0, 12),
    };
  }
}

export class DemoResearchProvider implements ResearchProvider {
  private summary(): string {
    return "Demo mode completed the section structure. Live web research will populate sourced findings.";
  }

  async contextBundle(_request: AnalyzeRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return {
      politicalContext: {
        status: "empty" as const,
        summary: "Demo mode does not research publication or journalist history.",
        signals: [],
      },
      journalistContext: {
        status: "empty" as const,
        summary: this.summary(),
        findings: [],
        emptyReason: "not-applicable" as const,
      },
    };
  }

  async evidenceBundle(_request: AnalyzeRequest, _claims: ResearchClaim[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return {
      supporting: {
        status: "empty" as const,
        summary: this.summary(),
        sources: [],
        emptyReason: "not-applicable" as const,
      },
      contradicting: {
        status: "empty" as const,
        summary: this.summary(),
        sources: [],
        emptyReason: "not-applicable" as const,
      },
      additionalContext: {
        status: "empty" as const,
        summary: this.summary(),
        sources: [],
        emptyReason: "not-applicable" as const,
      },
    };
  }
}
