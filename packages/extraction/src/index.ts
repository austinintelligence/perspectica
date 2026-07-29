import type {
  ArticleDocument,
  ArticleLink,
  ArticleParagraph,
  ContentType,
} from "@perspectica/contracts";

export const EXTRACTOR_VERSION = "dom-v3";

const excludedAncestorSelector =
  "nav, footer, aside, form, dialog, [aria-hidden='true'], [hidden], .advertisement, .ad, .promo, .newsletter, .comments, [class*='newsletter'], [class*='promo'], [data-component*='newsletter'], [data-component*='promo'], [data-testid*='newsletter']";

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const type = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
    if (type.some((entry) => entry === "NewsArticle" || entry === "Article")) {
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
    }

    if (record["@graph"]) visit(record["@graph"]);
  };

  for (const script of document.querySelectorAll<HTMLScriptElement>(
    "script[type='application/ld+json']",
  )) {
    try {
      visit(JSON.parse(script.textContent ?? ""));
    } catch {
      // Ignore malformed structured data and continue with visible metadata.
    }
  }

  return [...new Set(authors)];
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function getCanonicalUrl(document: Document, fallbackUrl: string): string {
  const canonical = document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
  const socialUrl = firstMeta(document, ["meta[property='og:url']"]);
  for (const candidate of [canonical, socialUrl, fallbackUrl]) {
    try {
      const url = new URL(candidate ?? fallbackUrl, fallbackUrl);
      if (url.protocol === "http:" || url.protocol === "https:") {
        url.hash = "";
        return url.toString();
      }
    } catch {
      // Try the next candidate.
    }
  }
  return fallbackUrl;
}

function chooseArticleRoot(document: Document): Element {
  const candidates = [
    ...document.querySelectorAll("article"),
    ...document.querySelectorAll("main"),
    ...document.querySelectorAll("[role='main']"),
  ];

  const scored = candidates
    .map((element) => {
      const paragraphs = [...element.querySelectorAll("p")].filter(
        (paragraph) => cleanText(paragraph.textContent).length >= 40,
      );
      const textLength = paragraphs.reduce(
        (total, paragraph) => total + cleanText(paragraph.textContent).length,
        0,
      );
      return { element, score: textLength + paragraphs.length * 200 };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.element ?? document.body ?? document.documentElement;
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

function extractParagraphs(root: Element): ArticleParagraph[] {
  const elements = [...root.querySelectorAll("h2, h3, p, blockquote")];
  const paragraphs: ArticleParagraph[] = [];

  for (const element of elements) {
    if (element.closest(excludedAncestorSelector)) continue;
    const text = cleanText(element.textContent);
    const tagName = element.tagName.toLocaleLowerCase("en-US");
    const kind =
      tagName === "blockquote" ? "quote" : tagName.startsWith("h") ? "heading" : "paragraph";
    const minimumLength = kind === "heading" ? 4 : 40;
    if (text.length < minimumLength) continue;

    paragraphs.push({
      id: `paragraph-${paragraphs.length + 1}`,
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
  }

  if (paragraphs.length === 0) {
    const fallback = cleanText(root.textContent);
    if (fallback) {
      paragraphs.push({
        id: "paragraph-1",
        index: 0,
        kind: "paragraph",
        text: fallback.slice(0, 20_000),
        speaker: null,
      });
    }
  }

  return paragraphs;
}

function findParagraphId(
  element: Element,
  root: Element,
  paragraphs: ArticleParagraph[],
): string | null {
  const containing = element.closest("p, blockquote, h2, h3");
  if (!containing || !root.contains(containing)) return null;
  const text = cleanText(containing.textContent);
  return paragraphs.find((paragraph) => paragraph.text === text)?.id ?? null;
}

function extractLinks(
  root: Element,
  canonicalUrl: string,
  paragraphs: ArticleParagraph[],
): ArticleLink[] {
  const seen = new Set<string>();
  const links: ArticleLink[] = [];

  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (anchor.closest(excludedAncestorSelector)) continue;
    let url: URL;
    try {
      url = new URL(anchor.href, canonicalUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const normalized = url.toString();
    if (normalized === canonicalUrl || seen.has(normalized)) continue;
    seen.add(normalized);

    const label =
      cleanText(anchor.textContent) ||
      cleanText(anchor.title) ||
      url.hostname.replace(/^www\./, "");
    links.push({
      id: `source-${links.length + 1}`,
      label,
      url: normalized,
      paragraphId: findParagraphId(anchor, root, paragraphs),
    });
  }

  return links;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
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
  const sample = paragraphs
    .slice(0, 20)
    .map((paragraph) => paragraph.text)
    .join("\n")
    .slice(0, 20_000);
  return `article-${fnv1a(`${canonicalUrl}\n${title}\n${sample}`)}`;
}

export function extractArticleDocument(document: Document, fallbackUrl: string): ArticleDocument {
  const canonicalUrl = getCanonicalUrl(document, fallbackUrl);
  const root = chooseArticleRoot(document);
  const title = extractTitle(document);
  const paragraphs = extractParagraphs(root);
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

  return {
    fingerprint: createArticleFingerprint(canonicalUrl, title, paragraphs),
    canonicalUrl,
    title,
    author: extractAuthor(document, publication),
    publication,
    publishedAt,
    language: cleanText(document.documentElement.lang) || null,
    contentType: detectContentType(document, canonicalUrl),
    paragraphs,
    links: extractLinks(root, canonicalUrl, paragraphs),
    extraction: {
      extractorVersion: EXTRACTOR_VERSION,
      extractedAt: new Date().toISOString(),
      wordCount: paragraphs.reduce(
        (total, paragraph) => total + paragraph.text.split(/\s+/).filter(Boolean).length,
        0,
      ),
    },
  };
}
