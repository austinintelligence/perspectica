import type { ArticleIndex, IndexedParagraph } from "@perspectica/contracts/article";
import { MAX_ARTICLE_SPINE_CHARACTERS } from "@perspectica/contracts/limits";
import type { AnalysisBudget } from "../budgets";

export interface ArticleContext {
  spine: string;
  deepPassages: Array<{
    paragraphId: string;
    text: string;
    score: number;
    reason: string;
  }>;
  selectedParagraphIds: string[];
  characters: number;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  return matches / Math.max(left.size, 1);
}

function paragraphScore(
  index: ArticleIndex,
  paragraph: IndexedParagraph,
): { score: number; reason: string } {
  const titleTokens = tokens(
    `${index.meta.title} ${index.outline
      .slice(0, 8)
      .map((item) => item.preview)
      .join(" ")}`,
  );
  const paragraphTokens = tokens(paragraph.text);
  const density = Math.min(1, (paragraph.tokenCount + paragraph.linkIds.length * 4) / 120);
  const lead = paragraph.index === 0 ? 0.32 : paragraph.index < 3 ? 0.16 : 0;
  const quote = paragraph.kind === "quote" || paragraph.speaker ? 0.14 : 0;
  const position = paragraph.position > 0.78 ? 0.08 : paragraph.position > 0.35 ? 0.05 : 0;
  const similarity = overlap(titleTokens, paragraphTokens) * 0.24;
  const score = lead + quote + position + density * 0.22 + similarity;
  const reasons = [
    lead > 0 ? "lead position" : "",
    quote > 0 ? "attribution or quotation" : "",
    density > 0.5 ? "fact density" : "",
    similarity > 0.08 ? "title and heading overlap" : "",
  ].filter(Boolean);
  return { score, reason: reasons.join(", ") || "article coverage" };
}

export function selectArticleContext(index: ArticleIndex, budget: AnalysisBudget): ArticleContext {
  const scored = index.paragraphOrder
    .map((id) => index.paragraphs[id])
    .filter((paragraph): paragraph is IndexedParagraph => Boolean(paragraph))
    .map((paragraph) => ({ paragraph, ...paragraphScore(index, paragraph) }));
  const selected = [...scored].sort((left, right) => right.score - left.score);
  const chosen: ArticleContext["deepPassages"] = [];
  let characters = 0;
  for (const candidate of selected) {
    if (characters >= budget.deepPassageCharacters) break;
    const remaining = budget.deepPassageCharacters - characters;
    const text = candidate.paragraph.text.slice(0, Math.max(0, remaining)).trim();
    if (!text) continue;
    chosen.push({
      paragraphId: candidate.paragraph.id,
      text,
      score: Math.round(candidate.score * 100) / 100,
      reason: candidate.reason,
    });
    characters += text.length;
  }
  chosen.sort(
    (left, right) =>
      index.paragraphs[left.paragraphId]!.index - index.paragraphs[right.paragraphId]!.index,
  );

  const spine = JSON.stringify({
    meta: index.meta,
    outline: index.outline.map((block) => ({
      id: block.id,
      i: block.index,
      k: block.kind,
      p: block.preview,
      h: block.headingPath,
      s: block.sentenceCount,
      e: block.entityCount,
      q: block.quantityCount,
      l: block.linkIds,
    })),
    entities: index.entities.slice(0, 500),
    quantities: index.quantities.slice(0, 500),
    dates: index.dates.slice(0, 500),
    links: index.links,
    claims: index.claimSeeds.slice(0, budget.maxClaims),
  }).slice(0, MAX_ARTICLE_SPINE_CHARACTERS);

  return {
    spine,
    deepPassages: chosen,
    selectedParagraphIds: chosen.map((passage) => passage.paragraphId),
    characters,
  };
}
