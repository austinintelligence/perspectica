import {
  ArticleIndexSchema,
  type ArticleIndex,
  type DeterministicClaimSeed,
  type EntityMention,
  type IndexedArticleLink,
  type IndexedParagraph,
  type IndexedSentence,
  type QuantityMention,
  type DateMention,
} from "@perspectica/contracts/article";
import type { ArticleDocument, ArticleLink } from "@perspectica/contracts";
import { ARTICLE_INDEX_VERSION } from "@perspectica/contracts/limits";
import { normalizeCanonicalUrl } from "@perspectica/contracts/url";

const ATTRIBUTION_VERBS =
  /\b(?:said|says|told|wrote|reported|according to|argued|claimed|alleged|announced|warned|explained|called|described|stated)\b/i;
const SOCIAL_HOSTS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "reddit.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "flipboard.com",
  "sharethis.com",
  "addtoany.com",
  "pinterest.com",
  "t.me",
  "telegram.me",
]);
const NON_EDITORIAL_HOSTS = new Set(["beyondwords.io"]);
const PROMOTIONAL_PATTERN =
  /\b(?:subscribe|newsletter|advert(?:isement)?|sponsor|shop|store|download|app|onelink|affiliate)\b/i;
const NAVIGATION_PATH =
  /(?:^|\/)(?:search|tag|topic|category|author|login|account|subscribe)(?:\/|$)/i;
const COMMON_CAPITALIZED = new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "After",
  "Before",
  "When",
  "What",
  "How",
  "A",
  "An",
]);

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function sentenceSpans(value: string): Array<{ text: string; start: number; end: number }> {
  const spans: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  for (const match of value.matchAll(pattern)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const leading = raw.search(/\S/);
    const text = normalized(raw);
    if (!text) continue;
    const offset = leading < 0 ? 0 : leading;
    spans.push({ text, start: start + offset, end: start + raw.length });
  }
  if (spans.length === 0 && value.trim()) {
    const start = value.search(/\S/);
    spans.push({ text: normalized(value), start: Math.max(0, start), end: value.length });
  }
  return spans;
}

function sentenceForParagraph(
  paragraphId: string,
  paragraph: ArticleDocument["paragraphs"][number],
): IndexedSentence[] {
  return sentenceSpans(paragraph.text).map((span, index) => ({
    id: `${paragraphId}-sentence-${index + 1}`,
    paragraphId,
    index,
    start: span.start,
    end: span.end,
    text: compact(span.text, 4_000),
    speaker: paragraph.speaker ?? null,
    attributionVerb: ATTRIBUTION_VERBS.test(span.text)
      ? (span.text.match(ATTRIBUTION_VERBS)?.[0] ?? null)
      : null,
    isQuoted: paragraph.kind === "quote" || /^\s*["“]/.test(span.text),
  }));
}

function detectEntities(
  text: string,
  paragraphId: string,
  sentenceId: string | null,
): EntityMention[] {
  const values = new Map<string, EntityMention>();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*){0,3}\b/g)) {
    const candidate = normalized(match[0] ?? "");
    if (!candidate || candidate.length < 2 || COMMON_CAPITALIZED.has(candidate)) continue;
    const key = candidate.toLocaleLowerCase("en-US");
    values.set(key, {
      text: candidate,
      normalized: key,
      kind: /\b(?:Inc|Corp|Company|Committee|Council|Department|Ministry|Party|University)\b/.test(
        candidate,
      )
        ? "organization"
        : "unknown",
      paragraphId,
      sentenceId,
    });
  }
  return [...values.values()].slice(0, 32);
}

function detectQuantities(
  text: string,
  paragraphId: string,
  sentenceId: string | null,
): QuantityMention[] {
  const result: QuantityMention[] = [];
  for (const match of text.matchAll(
    /(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*(?:\.\d+)?\s?%|\b\d[\d,.]*(?:\.\d+)?\s?(?:million|billion|thousand|years?|people|dollars?|euros?)\b)/gi,
  )) {
    const value = normalized(match[0] ?? "");
    if (!value) continue;
    result.push({
      text: value,
      normalized: value.toLocaleLowerCase("en-US"),
      kind: /%/.test(value)
        ? "percentage"
        : /^[$€£]/.test(value) || /dollars?|euros?/i.test(value)
          ? "currency"
          : /years?|people|million|billion|thousand/i.test(value)
            ? "measurement"
            : "number",
      paragraphId,
      sentenceId,
    });
  }
  return result.slice(0, 32);
}

function detectDates(text: string, paragraphId: string, sentenceId: string | null): DateMention[] {
  const result: DateMention[] = [];
  const pattern =
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s+\d{4})?|\b(?:19|20)\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gi;
  for (const match of text.matchAll(pattern)) {
    const value = normalized(match[0] ?? "");
    if (value)
      result.push({
        text: value,
        normalized: value.toLocaleLowerCase("en-US"),
        paragraphId,
        sentenceId,
      });
  }
  return result.slice(0, 16);
}

function host(value: string): string {
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return "";
  }
}

function linkClassification(
  link: ArticleLink,
  articleUrl: string,
): IndexedArticleLink["classification"] {
  const linkHost = host(link.url);
  const articleHost = host(articleUrl);
  if (!linkHost) return "unknown";
  if (linkHost === articleHost || linkHost.endsWith(`.${articleHost}`)) {
    return NAVIGATION_PATH.test(new URL(link.url).pathname) ? "navigation" : "same-publication";
  }
  if ([...SOCIAL_HOSTS].some((domain) => linkHost === domain || linkHost.endsWith(`.${domain}`))) {
    return "social";
  }
  if (NON_EDITORIAL_HOSTS.has(linkHost) || PROMOTIONAL_PATTERN.test(`${link.label} ${link.url}`)) {
    return "promotional";
  }
  if (
    /\.(?:gov|mil|edu)(?:\.|\/|$)/i.test(linkHost) ||
    /(?:record|filing|bill|data|report|pdf)/i.test(link.url)
  ) {
    return "likely-primary";
  }
  return "external";
}

export function buildArticleIndex(article: ArticleDocument): ArticleIndex {
  const sentences: IndexedSentence[] = [];
  const entities: EntityMention[] = [];
  const quantities: QuantityMention[] = [];
  const dates: DateMention[] = [];
  const paragraphs: Record<string, IndexedParagraph> = {};
  const headingPath: string[] = [];

  for (const paragraph of article.paragraphs) {
    if (paragraph.kind === "heading") {
      headingPath.splice(0, headingPath.length, paragraph.text);
    }
    const paragraphSentences = sentenceForParagraph(paragraph.id, paragraph);
    const paragraphEntities = paragraphSentences.flatMap((sentence) =>
      detectEntities(sentence.text, paragraph.id, sentence.id),
    );
    const paragraphQuantities = paragraphSentences.flatMap((sentence) =>
      detectQuantities(sentence.text, paragraph.id, sentence.id),
    );
    const paragraphDates = paragraphSentences.flatMap((sentence) =>
      detectDates(sentence.text, paragraph.id, sentence.id),
    );
    sentences.push(...paragraphSentences);
    entities.push(...paragraphEntities);
    quantities.push(...paragraphQuantities);
    dates.push(...paragraphDates);
    const linkIds = article.links
      .filter((link) => link.paragraphId === paragraph.id)
      .map((link) => link.id);
    paragraphs[paragraph.id] = {
      id: paragraph.id,
      index: paragraph.index,
      kind: paragraph.kind,
      text: paragraph.text,
      preview: compact(paragraph.text, 240),
      speaker: paragraph.speaker ?? null,
      sentenceIds: paragraphSentences.map((sentence) => sentence.id),
      headingPath: [...headingPath],
      linkIds,
      position:
        article.paragraphs.length <= 1 ? 0 : paragraph.index / (article.paragraphs.length - 1),
      tokenCount: paragraph.text.split(/\s+/).filter(Boolean).length,
    };
  }

  const indexedLinks: IndexedArticleLink[] = article.links.map((link) => ({
    id: link.id,
    url: normalizeCanonicalUrl(link.url, article.canonicalUrl) ?? link.url,
    label: compact(link.label, 1_000),
    paragraphId: link.paragraphId ?? null,
    classification: linkClassification(link, article.canonicalUrl),
    host: host(link.url) || "unknown",
  }));

  const claimSeeds: DeterministicClaimSeed[] = [];
  for (const paragraph of article.paragraphs) {
    if (paragraph.kind === "heading") continue;
    const paragraphSentences = sentences.filter(
      (sentence) => sentence.paragraphId === paragraph.id,
    );
    const paragraphEntities = entities.filter((entity) => entity.paragraphId === paragraph.id);
    const paragraphQuantities = quantities.filter(
      (quantity) => quantity.paragraphId === paragraph.id,
    );
    const paragraphDates = dates.filter((date) => date.paragraphId === paragraph.id);
    const factual = paragraphEntities.length + paragraphQuantities.length + paragraphDates.length;
    if (
      factual === 0 &&
      !/\b(?:approved|announced|voted|released|found|showed|increased|decreased|will|has|had|is|are|was|were)\b/i.test(
        paragraph.text,
      )
    )
      continue;
    const firstSentence = paragraphSentences[0];
    if (!firstSentence) continue;
    const id = `claim-seed-${hash(`${paragraph.id}:${firstSentence.text}`)}`;
    claimSeeds.push({
      id,
      paragraphIds: [paragraph.id],
      sentenceIds: paragraphSentences.slice(0, 4).map((sentence) => sentence.id),
      text: compact(paragraph.text, 1_200),
      entities: paragraphEntities.slice(0, 8).map((entity) => entity.text),
      quantities: paragraphQuantities.slice(0, 8).map((quantity) => quantity.text),
      dates: paragraphDates.slice(0, 8).map((date) => date.text),
      attribution:
        paragraph.speaker ??
        (ATTRIBUTION_VERBS.test(paragraph.text) ? compact(paragraph.text, 300) : null),
      checkability: Math.min(1, 0.3 + factual * 0.12 + (paragraph.kind === "quote" ? 0.1 : 0)),
    });
  }

  const outline = article.paragraphs.map((paragraph) => {
    const indexed = paragraphs[paragraph.id]!;
    return {
      id: paragraph.id,
      index: paragraph.index,
      kind: paragraph.kind,
      preview: indexed.preview,
      headingPath: indexed.headingPath,
      sentenceCount: indexed.sentenceIds.length,
      entityCount: entities.filter((entity) => entity.paragraphId === paragraph.id).length,
      quantityCount: quantities.filter((quantity) => quantity.paragraphId === paragraph.id).length,
      linkIds: indexed.linkIds,
    };
  });

  return ArticleIndexSchema.parse({
    version: ARTICLE_INDEX_VERSION,
    fingerprint: article.fingerprint,
    meta: {
      title: article.title,
      author: article.author,
      publication: article.publication,
      publishedAt: article.publishedAt,
      canonicalUrl: article.canonicalUrl,
      contentType: article.contentType,
      language: article.language,
    },
    outline,
    paragraphs,
    paragraphOrder: article.paragraphs.map((paragraph) => paragraph.id),
    sentences: Object.fromEntries(sentences.map((sentence) => [sentence.id, sentence])),
    entities,
    quantities,
    dates,
    links: indexedLinks,
    claimSeeds: claimSeeds.slice(0, 128),
    extraction: {
      extractorVersion: article.extraction.extractorVersion,
      indexedAt: new Date().toISOString(),
      wordCount: article.extraction.wordCount,
      contentChars:
        article.extraction.contentChars ??
        article.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
      paragraphCount: article.paragraphs.length,
      sentenceCount: sentences.length,
      linkCount: indexedLinks.length,
      contentTruncated: article.extraction.contentTruncated ?? false,
      articleStatus: article.extraction.articleStatus === "uncertain" ? "uncertain" : "article",
    },
  });
}
