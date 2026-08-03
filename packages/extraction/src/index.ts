import type {
  ArticleDocument,
  ArticleLink,
  ArticleParagraph,
  ContentType,
} from "@perspectica/contracts";
import {
  ARTICLE_MAX_CONTENT_CHARS,
  ARTICLE_MAX_LINKS,
  ARTICLE_MAX_PARAGRAPH_CHARS,
  ArticleDocumentSchema,
  normalizeCanonicalUrl,
} from "@perspectica/contracts";
import { buildArticleIndex } from "./article-index";

export { buildArticleIndex } from "./article-index";
export type { ArticleIndex } from "@perspectica/contracts/article";

export const EXTRACTOR_VERSION = "dom-v6";

export class ArticleExtractionError extends Error {
  readonly code = "NOT_ARTICLE";

  constructor(message = "This page does not appear to contain a readable article.") {
    super(message);
    this.name = "ArticleExtractionError";
  }
}

const excludedAncestorSelector =
  "nav, footer, aside, form, dialog, [aria-hidden='true'], [hidden], [inert], template, noscript, .advertisement, .ad, .promo, .newsletter, .comments, [class*='newsletter'], [class*='promo'], [data-component*='newsletter'], [data-component*='promo'], [data-testid*='newsletter']";

const MAX_JSON_LD_SCRIPTS = 24;
const MAX_JSON_LD_CHARS = 128_000;
const MAX_JSON_LD_DEPTH = 24;
const MAX_JSON_LD_NODES = 2_000;

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Page HTML is untrusted input, so ignore content readers cannot see. */
function isVisibleContent(element: Element): boolean {
  if (element.closest(excludedAncestorSelector)) return false;
  const ownStyle = element.getAttribute("style")?.toLocaleLowerCase("en-US") ?? "";
  if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(ownStyle)) return false;
  try {
    const style = window.getComputedStyle?.(element);
    return style?.display !== "none" && style?.visibility !== "hidden";
  } catch {
    return true;
  }
}

function parseBoundedJsonLd(value: string): unknown | null {
  if (!value || value.length > MAX_JSON_LD_CHARS) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function visitBoundedJson(
  value: unknown,
  visitor: (record: Record<string, unknown>) => boolean | void,
): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0 && nodes < MAX_JSON_LD_NODES) {
    const current = stack.pop();
    if (!current || current.depth > MAX_JSON_LD_DEPTH) continue;
    nodes += 1;
    if (Array.isArray(current.value)) {
      for (const child of current.value.slice(0, MAX_JSON_LD_NODES - nodes)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const record = current.value as Record<string, unknown>;
    if (visitor(record) === true) return true;
    if (record["@graph"] !== undefined) {
      stack.push({ value: record["@graph"], depth: current.depth + 1 });
    }
  }
  return false;
}

function firstMeta(document: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const value = document.querySelector<HTMLMetaElement>(selector)?.content;
    const cleaned = cleanText(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function firstText(document: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const value = cleanText(document.querySelector(selector)?.textContent);
    if (value) return value;
  }
  return null;
}

function cleanAuthorCandidate(
  value: string | null | undefined,
  publication?: string | null,
): string | null {
  let cleaned = cleanText(value)
    .replace(/^(?:by\s+)+/i, "")
    .replace(/\s+(?:published|updated)\b.*$/i, "")
    .trim();
  const publicationName = cleanText(publication);
  if (
    publicationName &&
    cleaned.toLocaleLowerCase("en-US").endsWith(` ${publicationName.toLocaleLowerCase("en-US")}`)
  ) {
    cleaned = cleaned.slice(0, -(publicationName.length + 1)).trim();
  }
  if (!cleaned || cleaned.length > 240) return null;
  if (/^(?:https?:\/\/|www\.|mailto:)/i.test(cleaned)) return null;
  if (/\b(?:facebook|instagram|twitter|x\.com|youtube)\.com\b/i.test(cleaned)) return null;
  if (/^[\w.-]+@[\w.-]+\.[a-z]{2,}$/i.test(cleaned)) return null;
  if (/^(?:bbc\s*news|staff|news desk|editorial team)$/i.test(cleaned)) return null;
  return cleaned;
}

function jsonLdAuthors(document: Document, publication: string | null): string[] {
  const authors: string[] = [];
  const scripts = [
    ...document.querySelectorAll<HTMLScriptElement>("script[type='application/ld+json']"),
  ].slice(0, MAX_JSON_LD_SCRIPTS);
  for (const script of scripts) {
    const parsed = parseBoundedJsonLd(script.textContent ?? "");
    if (!parsed) continue;
    visitBoundedJson(parsed, (record) => {
      const type = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
      if (!type.some((entry) => entry === "NewsArticle" || entry === "Article")) return;
      const authorValues = Array.isArray(record.author) ? record.author : [record.author];
      for (const author of authorValues) {
        const name =
          typeof author === "string"
            ? author
            : author && typeof author === "object"
              ? (author as Record<string, unknown>).name
              : null;
        const cleaned = cleanAuthorCandidate(typeof name === "string" ? name : null, publication);
        if (cleaned) authors.push(cleaned);
      }
    });
  }

  return [...new Set(authors)];
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function getCanonicalUrl(document: Document, fallbackUrl: string): string {
  const actualUrl = normalizeCanonicalUrl(fallbackUrl);
  if (!actualUrl) {
    throw new ArticleExtractionError("The current page does not have a valid web URL.");
  }
  const canonical = document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
  const socialUrl = firstMeta(document, ["meta[property='og:url']"]);
  const actualOrigin = new URL(actualUrl).origin;
  for (const candidate of [canonical, socialUrl]) {
    const normalized = normalizeCanonicalUrl(candidate ?? "", actualUrl);
    // Page metadata is untrusted. A cross-origin canonical must never replace
    // the identity of the tab the user explicitly asked us to analyze.
    if (normalized && new URL(normalized).origin === actualOrigin) return normalized;
  }
  return actualUrl;
}

type ArticleRoot = {
  element: Element;
  status: "article" | "uncertain";
};

function hasStructuredArticleData(document: Document): boolean {
  return [...document.querySelectorAll<HTMLScriptElement>("script[type='application/ld+json']")]
    .slice(0, MAX_JSON_LD_SCRIPTS)
    .some((script) => {
      const parsed = parseBoundedJsonLd(script.textContent ?? "");
      return (
        parsed !== null &&
        visitBoundedJson(parsed, (record) => {
          const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
          return types.some((entry) => entry === "NewsArticle" || entry === "Article");
        })
      );
    });
}

function hasArticleMetadata(document: Document): boolean {
  const declaredType = firstMeta(document, ["meta[property='og:type']", "meta[name='og:type']"]);
  return (
    declaredType?.toLocaleLowerCase("en-US") === "article" ||
    Boolean(
      firstMeta(document, ["meta[property='article:published_time']", "meta[name='date']"]),
    ) ||
    hasStructuredArticleData(document)
  );
}

function hasArticleTitle(document: Document): boolean {
  return Boolean(
    firstMeta(document, ["meta[property='og:title']", "meta[name='twitter:title']"]) ||
    firstText(document, ["article h1", "main h1", "h1"]),
  );
}

function chooseArticleRoot(document: Document, canonicalUrl: string): ArticleRoot {
  const candidates = [
    ...document.querySelectorAll("article"),
    ...document.querySelectorAll("main"),
    ...document.querySelectorAll("[role='main']"),
  ];

  const scored = candidates
    .map((element) => {
      const paragraphs = [...element.querySelectorAll("p")].filter(
        (paragraph) => isVisibleContent(paragraph) && cleanText(paragraph.textContent).length >= 40,
      );
      const textLength = paragraphs.reduce(
        (total, paragraph) => total + cleanText(paragraph.textContent).length,
        0,
      );
      return {
        element,
        longParagraphs: paragraphs.length,
        score: textLength + paragraphs.length * 200,
        hasHeading: Boolean(element.querySelector("h1")),
      };
    })
    .sort((left, right) => right.score - left.score);

  const path = new URL(canonicalUrl).pathname.toLocaleLowerCase("en-US");
  const genericPath =
    /(?:^|\/)(?:search|login|logout|signup|register|account|profile|tag|tags|topic|topics|category|categories|author|authors|videos?)(?:\/|$)/.test(
      path,
    );
  const metadata = hasArticleMetadata(document);
  const titleMetadata = hasArticleTitle(document);
  const explicitArticle = scored.find(
    (candidate) => candidate.element.tagName.toLowerCase() === "article",
  );

  if (explicitArticle && explicitArticle.longParagraphs > 0 && (!genericPath || metadata)) {
    return { element: explicitArticle.element, status: "article" };
  }

  const likelyArticle = scored.find(
    (candidate) =>
      candidate.longParagraphs > 0 &&
      !genericPath &&
      (metadata ||
        (titleMetadata && candidate.element.tagName.toLocaleLowerCase("en-US") === "main") ||
        (candidate.hasHeading && candidate.longParagraphs >= 2)),
  );
  if (likelyArticle) {
    return {
      element: likelyArticle.element,
      status: metadata ? "article" : "uncertain",
    };
  }

  // Some publishers expose article metadata but put the readable body
  // directly under <body>. That is safe to support because structured article
  // metadata distinguishes it from a generic page shell.
  const body = document.body ?? document.documentElement;
  const bodyParagraphs = [...body.querySelectorAll("p")].filter(
    (paragraph) => isVisibleContent(paragraph) && cleanText(paragraph.textContent).length >= 40,
  );
  if (metadata && !genericPath && bodyParagraphs.length > 0) {
    return { element: body, status: "article" };
  }

  throw new ArticleExtractionError(
    "Open a news article or other long-form story, then try again. Generic pages and navigation screens are not analyzed.",
  );
}

function extractTitle(document: Document): string {
  const title =
    firstMeta(document, ["meta[property='og:title']", "meta[name='twitter:title']"]) ??
    firstText(document, ["article h1", "main h1", "h1"]) ??
    cleanText(document.title);

  return title || "Untitled article";
}

function extractAuthor(document: Document, publication: string | null): string | null {
  const visibleSelectors = [
    "[data-testid='byline-name']",
    "[data-testid*='byline'] [rel='author']",
    "[itemprop='author'] [itemprop='name']",
    "[rel='author']",
    "[itemprop='author']",
    ".byline",
    ".author",
    "[class*='byline']",
  ];
  for (const selector of visibleSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      const visibleAuthor = cleanAuthorCandidate(element.textContent, publication);
      if (visibleAuthor) return visibleAuthor;
    }
  }

  const structuredAuthors = jsonLdAuthors(document, publication);
  if (structuredAuthors.length > 0) return structuredAuthors.join(", ");

  return cleanAuthorCandidate(
    firstMeta(document, [
      "meta[name='author']",
      "meta[property='article:author']",
      "meta[name='byl']",
    ]),
    publication,
  );
}

function detectContentType(document: Document, canonicalUrl: string): ContentType {
  const declared = cleanText(
    firstMeta(document, [
      "meta[property='article:section']",
      "meta[name='article:section']",
      "meta[name='section']",
      "meta[name='parsely-section']",
    ]),
  ).toLocaleLowerCase("en-US");
  const path = new URL(canonicalUrl).pathname.toLocaleLowerCase("en-US");
  const combined = `${declared} ${path}`;

  if (/\b(opinion|editorial|commentary|columns?)\b/.test(combined)) return "opinion";
  if (/\b(analysis|explainer|fact-check)\b/.test(combined)) return "analysis";
  return "news";
}

function extractParagraphs(root: Element): {
  paragraphs: ArticleParagraph[];
  truncated: boolean;
  paragraphElements: Map<Element, string>;
} {
  const elements = [...root.querySelectorAll("h2, h3, p, blockquote")];
  const paragraphs: ArticleParagraph[] = [];
  const paragraphElements = new Map<Element, string>();
  let contentChars = 0;
  let truncated = false;

  for (const element of elements) {
    if (!isVisibleContent(element)) continue;
    const originalText = cleanText(element.textContent);
    const tagName = element.tagName.toLocaleLowerCase("en-US");
    const kind =
      tagName === "blockquote" ? "quote" : tagName.startsWith("h") ? "heading" : "paragraph";
    const minimumLength = kind === "heading" ? 4 : 40;
    if (originalText.length < minimumLength) continue;

    const remaining = ARTICLE_MAX_CONTENT_CHARS - contentChars;
    if (remaining < minimumLength) {
      truncated = true;
      break;
    }
    const text = originalText.slice(0, Math.min(ARTICLE_MAX_PARAGRAPH_CHARS, remaining)).trim();
    if (text.length < minimumLength) {
      truncated = true;
      break;
    }
    if (
      text.length < originalText.length ||
      contentChars + text.length >= ARTICLE_MAX_CONTENT_CHARS
    ) {
      truncated = true;
    }

    const id = `paragraph-${paragraphs.length + 1}`;
    paragraphs.push({
      id,
      index: paragraphs.length,
      kind,
      text,
      speaker:
        kind === "quote"
          ? cleanText(element.getAttribute("cite")) ||
            cleanText(element.querySelector("cite")?.textContent) ||
            null
          : null,
    });
    // Keep the DOM identity captured at traversal time. Comparing extracted
    // text later is lossy when paragraphs are truncated or duplicated.
    paragraphElements.set(element, id);
    contentChars += text.length;
    if (contentChars >= ARTICLE_MAX_CONTENT_CHARS) break;
  }

  return { paragraphs, truncated, paragraphElements };
}

function findParagraphId(
  element: Element,
  root: Element,
  paragraphElements: ReadonlyMap<Element, string>,
): string | null {
  const containing = element.closest("p, blockquote, h2, h3");
  if (!containing || !root.contains(containing)) return null;
  return paragraphElements.get(containing) ?? null;
}

function extractLinks(
  root: Element,
  canonicalUrl: string,
  paragraphElements: ReadonlyMap<Element, string>,
): ArticleLink[] {
  const seen = new Set<string>();
  const links: ArticleLink[] = [];

  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (links.length >= ARTICLE_MAX_LINKS) break;
    if (!isVisibleContent(anchor)) continue;
    const normalized = normalizeCanonicalUrl(anchor.href, canonicalUrl);
    if (!normalized || normalized === canonicalUrl || seen.has(normalized)) continue;
    seen.add(normalized);
    const url = new URL(normalized);

    const label =
      cleanText(anchor.textContent) ||
      cleanText(anchor.title) ||
      url.hostname.replace(/^www\./, "");
    links.push({
      id: `source-${links.length + 1}`,
      label,
      url: normalized,
      paragraphId: findParagraphId(anchor, root, paragraphElements),
    });
  }

  return links;
}

function fnv1a(value: string, seed = 0x811c9dc5): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createArticleFingerprint(
  canonicalUrl: string,
  title: string,
  paragraphs: ArticleParagraph[],
): string {
  // The fingerprint is the background runtime's authority for deciding
  // whether a persisted report still belongs to the page. Hash the entire
  // bounded extraction (at most 300k characters) so live blogs and dynamic
  // article pages cannot silently reuse a report after only a later paragraph
  // changed.
  const content = paragraphs.map((paragraph) => `${paragraph.kind}:${paragraph.text}`).join("\n");
  const payload = `${canonicalUrl}\n${title}\n${content}`;
  return `article-${fnv1a(payload)}${fnv1a(payload, 0x9e3779b9)}`;
}

export function extractArticleDocument(document: Document, fallbackUrl: string): ArticleDocument {
  const canonicalUrl = getCanonicalUrl(document, fallbackUrl);
  const root = chooseArticleRoot(document, canonicalUrl);
  const title = extractTitle(document);
  const extracted = extractParagraphs(root.element);
  if (extracted.paragraphs.length === 0) {
    throw new ArticleExtractionError("No readable article paragraphs were found on this page.");
  }
  const contentChars = extracted.paragraphs.reduce(
    (total, paragraph) => total + paragraph.text.length,
    0,
  );
  const publication = firstMeta(document, [
    "meta[property='og:site_name']",
    "meta[name='application-name']",
  ]);
  const publishedAt = toIsoDate(
    firstMeta(document, [
      "meta[property='article:published_time']",
      "meta[name='article:published_time']",
      "meta[name='date']",
      "meta[name='pubdate']",
      "meta[name='parsely-pub-date']",
    ]),
  );

  return ArticleDocumentSchema.parse({
    fingerprint: createArticleFingerprint(canonicalUrl, title, extracted.paragraphs),
    canonicalUrl,
    title,
    author: extractAuthor(document, publication),
    publication,
    publishedAt,
    language: cleanText(document.documentElement.lang) || null,
    contentType: detectContentType(document, canonicalUrl),
    paragraphs: extracted.paragraphs,
    links: extractLinks(root.element, canonicalUrl, extracted.paragraphElements),
    extraction: {
      extractorVersion: EXTRACTOR_VERSION,
      extractedAt: new Date().toISOString(),
      wordCount: extracted.paragraphs.reduce(
        (total, paragraph) => total + paragraph.text.split(/\s+/).filter(Boolean).length,
        0,
      ),
      articleStatus: root.status,
      contentChars,
      contentTruncated: extracted.truncated,
      rejectionReason: null,
    },
  });
}

/**
 * One extraction pass can hand the intelligence runtime its immutable index.
 * The legacy document export remains available for narrow wire compatibility
 * and older integrations, but production V2 callers should use this entry.
 */
export function extractArticleIndex(document: Document, fallbackUrl: string) {
  return buildArticleIndex(extractArticleDocument(document, fallbackUrl));
}
