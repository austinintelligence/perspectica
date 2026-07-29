import type {
  ArticleDocument,
  ArticleLink,
  BiasFinding,
  BiasResult,
  CompassEvidence,
  ExternalSource,
  SourceListResult,
} from "@perspectica/contracts";

const SOURCE_LIST_LIMIT = 8;
const SOURCE_LIST_PER_HOST_LIMIT = 2;
const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref"]);
const UTILITY_LINK_LABEL =
  /^(see all topics?|all topics?|follow|home|homepage|read more|learn more|related|more|next|previous|sign up|subscribe|advertisement)$/i;
const PROMOTIONAL_LINK_LABEL =
  /\b(sign[\s-]?up|subscribe|subscription|newsletter|email alerts?|outside the uk|readers? in the uk)\b/i;
const PROMOTIONAL_LINK_URL =
  /(?:^|[./_-])(newsletter|newsletters|signup|sign-up|subscribe|subscription)(?:[./?_-]|$)/i;
const SAME_PUBLICATION_NAVIGATION_PATH = /(?:^|\/)(?:category|person|topic|tag|search)(?:\/|$)/i;
const BOILERPLATE_LINK_URL =
  /(?:^|\/)(?:about(?:-us)?|contact|privacy|terms|trust-principles|standards-and-values|corrections-policy|accessibility)(?:[./?_-]|$)/i;
const RELATED_STORY_LABEL =
  /^(?:read more|related|related story|more from|recommended|watch|listen|click here)\b/i;
const CITATION_CONTEXT =
  /\b(?:according to|data from|documents? from|records? from|reported by|previously reported|analysis by|study by|research by|statement from|court filing|official report|government data|review found)\b/i;
const WEAK_CITATION_LABEL =
  /^(?:(?:he|she|they|it)\s+)?(?:said|says|reported|reports|found|wrote|explained|acknowledged|spoke|posted|joined|continued|covered|claimed|interviewed|challenged|made clear|wrote for|own website|various|analyses|have found)$/i;
const SOCIAL_HOSTS = new Set([
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
]);
const PUBLICATION_NAMES: Record<string, string> = {
  "aaa.com": "AAA",
  "bbc.com": "BBC",
  "bea.gov": "U.S. Bureau of Economic Analysis",
  "bls.gov": "U.S. Bureau of Labor Statistics",
  "canada.ca": "Government of Canada",
  "caranddriver.com": "Car and Driver",
  "carnegieendowment.org": "Carnegie Endowment",
  "cbo.gov": "Congressional Budget Office",
  "cfr.org": "Council on Foreign Relations",
  "cnn.com": "CNN",
  "congress.gov": "Congress.gov",
  "ctvnews.ca": "CTV News",
  "fred.stlouisfed.org": "Federal Reserve Economic Data",
  "foxnews.com": "Fox News",
  "gao.gov": "U.S. Government Accountability Office",
  "nato.int": "NATO",
  "news.un.org": "United Nations News",
  "nytimes.com": "The New York Times",
  "rev.com": "Rev",
  "reuters.com": "Reuters",
  "ssa.gov": "Social Security Administration",
  "treasury.gov": "U.S. Treasury",
  "thefp.com": "The Free Press",
  "whitehouse.gov": "The White House",
  "x.com": "X",
};

const BIAS_DISPLAY_NAMES: Record<BiasFinding["technique"], string> = {
  "word-choice": "Loaded word choice",
  speculation: "Speculation",
  "unsubstantiated-claims": "Unsubstantiated claims",
  "cherry-picking": "Cherry-picking",
  "source-selection": "Source selection",
  whataboutism: "Whataboutism",
  "false-balance": "False balance",
  "false-dichotomy": "False dichotomy",
  "flawed-comparison": "Flawed comparison",
  generalization: "Generalization",
  "ad-hominem": "Ad hominem",
  "emotional-sensationalism": "Emotional or sensational framing",
  "straw-man": "Straw man",
};

const punctuationMap: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u00a0": " ",
};

export function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u00a0]/g, (character) => {
      return punctuationMap[character] ?? character;
    })
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function excerptMatchesParagraph(excerpt: string, paragraph: string): boolean {
  const normalizedExcerpt = normalizeEvidenceText(excerpt);
  const normalizedParagraph = normalizeEvidenceText(paragraph);
  return normalizedExcerpt.length >= 12 && normalizedParagraph.includes(normalizedExcerpt);
}

export function validateCompassEvidence(
  article: ArticleDocument,
  candidates: CompassEvidence[],
): CompassEvidence[] {
  const paragraphById = new Map(article.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const paragraph = paragraphById.get(candidate.paragraphId);
    if (!paragraph || !excerptMatchesParagraph(candidate.excerpt, paragraph.text)) {
      return false;
    }
    const expectedDirection =
      candidate.score < -0.2 ? "left" : candidate.score > 0.2 ? "right" : "center";
    if (candidate.direction !== expectedDirection) return false;

    const key = `${candidate.direction}:${candidate.score.toFixed(2)}:${normalizeEvidenceText(candidate.excerpt)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isAttributedRhetoricFinding(
  paragraph: ArticleDocument["paragraphs"][number],
  candidate: BiasFinding,
): boolean {
  if (
    candidate.technique !== "word-choice" &&
    candidate.technique !== "ad-hominem" &&
    candidate.technique !== "emotional-sensationalism"
  ) {
    return false;
  }

  const trimmedExcerpt = candidate.excerpt.trim();
  const excerptLooksQuoted =
    paragraph.kind === "quote" ||
    /^["'“‘].+["'”’][,.;:!?]?$/.test(trimmedExcerpt) ||
    (/["'“”‘’]/.test(trimmedExcerpt) && trimmedExcerpt.split(/\s+/).length <= 18);
  if (!excerptLooksQuoted) return false;

  return /\b(said|says|told|wrote|posted|argued|accused|called|described|criticised|criticized|claimed|according to|remarks?|rhetoric)\b/i.test(
    paragraph.text,
  );
}

function isAbsenceOnlySelectionFinding(candidate: BiasFinding): boolean {
  if (candidate.technique !== "cherry-picking" && candidate.technique !== "source-selection") {
    return false;
  }

  return /\b(without|fails? to|does not|did not|omits?|lacks?|missing|no broader context)\b/i.test(
    candidate.explanation,
  );
}

export function validateBiasFindings(
  article: ArticleDocument,
  candidates: BiasFinding[],
): BiasResult {
  const paragraphById = new Map(article.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const seenExcerpts = new Set<string>();
  const seenTechniques = new Set<BiasFinding["technique"]>();
  const valid = candidates
    .flatMap((candidate) => {
      const paragraph = paragraphById.get(candidate.paragraphId);
      if (
        !paragraph ||
        !excerptMatchesParagraph(candidate.excerpt, paragraph.text) ||
        isAttributedRhetoricFinding(paragraph, candidate) ||
        isAbsenceOnlySelectionFinding(candidate)
      ) {
        return [];
      }
      return [
        {
          ...candidate,
          displayName: BIAS_DISPLAY_NAMES[candidate.technique],
        },
      ];
    })
    .sort((left, right) => {
      const leftImpact = left.confidence * left.relevance * left.prominence;
      const rightImpact = right.confidence * right.relevance * right.prominence;
      return rightImpact - leftImpact;
    })
    .filter((candidate) => {
      const excerptKey = normalizeEvidenceText(candidate.excerpt);
      if (seenExcerpts.has(excerptKey) || seenTechniques.has(candidate.technique)) return false;
      seenExcerpts.add(excerptKey);
      seenTechniques.add(candidate.technique);
      return true;
    })
    .slice(0, 3);

  if (valid.length === 0) {
    return {
      status: "empty",
      summary:
        "No meaningful bias technique was verified in the article's own narration or presentation.",
      findings: [],
    };
  }

  return {
    status: "ready",
    summary:
      "These verified choices in the article's own wording or presentation may shape how readers interpret the story.",
    findings: valid,
  };
}

function normalizedSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || TRACKING_PARAMETERS.has(key)) {
        url.searchParams.delete(key);
      }
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedHost(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/^www\./, "");
}

function samePublicationHost(left: string, right: string): boolean {
  const normalizedLeft = normalizedHost(left);
  const normalizedRight = normalizedHost(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`.${normalizedRight}`) ||
    normalizedRight.endsWith(`.${normalizedLeft}`)
  );
}

function publicationName(hostname: string): string {
  const host = normalizedHost(hostname);
  const known = Object.entries(PUBLICATION_NAMES).find(
    ([domain]) => host === domain || host.endsWith(`.${domain}`),
  );
  if (known) return known[1];

  const parts = host.split(".");
  const candidate = parts.at(-2) ?? parts[0] ?? host;
  return candidate
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase("en-US") + part.slice(1))
    .join(" ");
}

function publicationKey(hostname: string): string {
  const host = normalizedHost(hostname);
  const known = Object.keys(PUBLICATION_NAMES).find(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  if (known) return known;
  return host.split(".").slice(-2).join(".");
}

function cleanCitationText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\bexternal\b/gi, "")
    .replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, "")
    .trim();
}

function normalizeCitationTitle(value: string): string {
  const title = cleanCitationText(value).slice(0, 140);
  const letters = title.match(/\p{L}/gu) ?? [];
  if (letters.length === 0 || title !== title.toLocaleUpperCase("en-US")) {
    return title.charAt(0).toLocaleUpperCase("en-US") + title.slice(1);
  }

  return title
    .toLocaleLowerCase("en-US")
    .split(/\s+/)
    .map((word) => word.charAt(0).toLocaleUpperCase("en-US") + word.slice(1))
    .join(" ");
}

function hasMeaningfulCitationLabel(label: string): boolean {
  const cleaned = cleanCitationText(label);
  if (cleaned.length < 4 || UTILITY_LINK_LABEL.test(cleaned)) return false;
  if (WEAK_CITATION_LABEL.test(cleaned)) return false;
  if (/^(according to|of |was |were |is |are |has |have |which |who |that |this )/i.test(cleaned)) {
    return false;
  }
  if (/^(here|this|source|link)$/i.test(cleaned)) return false;
  return true;
}

function pathTitle(url: URL): string | null {
  const ignored = new Set(["article", "business", "index", "news", "politics", "text", "world"]);
  const segment = url.pathname
    .split("/")
    .map((part) => decodeURIComponent(part).replace(/\.[a-z0-9]{2,5}$/i, ""))
    .reverse()
    .find(
      (part) =>
        part.length >= 5 && !ignored.has(part.toLocaleLowerCase("en-US")) && !/^\d+$/.test(part),
    );
  if (!segment) return null;

  const cleaned = cleanCitationText(
    segment
      .replace(/[-_]+/g, " ")
      .replace(/\b\d{4}\b/g, "")
      .replace(/\s+/g, " "),
  );
  if (cleaned.length < 4) return null;
  return cleaned.charAt(0).toLocaleUpperCase("en-US") + cleaned.slice(1);
}

function citationLabel(link: ArticleLink, url: URL): string {
  const publication = publicationName(url.hostname);
  const title = hasMeaningfulCitationLabel(link.label)
    ? cleanCitationText(link.label)
    : pathTitle(url);
  if (!title || title.toLocaleLowerCase("en-US") === publication.toLocaleLowerCase("en-US")) {
    return publication;
  }
  const normalizedTitle = normalizeCitationTitle(title);
  return `${publication} — ${normalizedTitle}`;
}

function sourceScore(link: ArticleLink, url: URL, articleHost: string, index: number): number {
  const host = normalizedHost(url.hostname);
  let score = 100 - index / 1_000;
  if (link.paragraphId) score += 20;
  if (!samePublicationHost(host, articleHost)) score += 12;
  if (host.endsWith(".gov") || host.endsWith(".edu") || host.endsWith(".int")) score += 18;
  if (url.pathname.toLocaleLowerCase("en-US").endsWith(".pdf")) score += 5;
  if (hasMeaningfulCitationLabel(link.label)) score += 4;
  if (SOCIAL_HOSTS.has(host)) score -= 25;
  return score;
}

function isLikelyOriginalCitation(
  link: ArticleLink,
  url: URL,
  articleHost: string,
  paragraphText: string,
): boolean {
  if (BOILERPLATE_LINK_URL.test(`${url.hostname}${url.pathname}`)) return false;
  const label = cleanCitationText(link.label);
  if (RELATED_STORY_LABEL.test(label)) return false;
  if (!samePublicationHost(url.hostname, articleHost)) return true;

  // Same-publication links are commonly recirculation cards. Keep one only
  // when the prose explicitly presents it as prior reporting, data, or another
  // cited record.
  return CITATION_CONTEXT.test(paragraphText);
}

export function buildSourceList(article: ArticleDocument): SourceListResult {
  const articleHost = normalizedHost(new URL(article.canonicalUrl).hostname);
  const paragraphById = new Map(
    article.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]),
  );
  const seen = new Set<string>();
  const candidates = article.links.flatMap((link, index) => {
    if (!link.paragraphId || UTILITY_LINK_LABEL.test(cleanCitationText(link.label))) {
      return [];
    }
    const normalized = normalizedSourceUrl(link.url);
    if (!normalized || seen.has(normalized.toLocaleLowerCase("en-US"))) return [];

    const url = new URL(normalized);
    if (normalized === normalizedSourceUrl(article.canonicalUrl)) return [];
    if (
      samePublicationHost(url.hostname, articleHost) &&
      SAME_PUBLICATION_NAVIGATION_PATH.test(url.pathname)
    ) {
      return [];
    }
    if (
      PROMOTIONAL_LINK_LABEL.test(cleanCitationText(link.label)) ||
      PROMOTIONAL_LINK_URL.test(`${url.hostname}${url.pathname}`)
    ) {
      return [];
    }
    const paragraphText = link.paragraphId ? (paragraphById.get(link.paragraphId) ?? "") : "";
    if (!isLikelyOriginalCitation(link, url, articleHost, paragraphText)) {
      return [];
    }
    seen.add(normalized.toLocaleLowerCase("en-US"));
    return [
      {
        link,
        url,
        score: sourceScore(link, url, articleHost, index),
      },
    ];
  });

  const perPublication = new Map<string, number>();
  const selected = candidates
    .sort((left, right) => right.score - left.score)
    .filter(({ url }) => {
      const publication = publicationKey(url.hostname);
      const count = perPublication.get(publication) ?? 0;
      if (count >= SOURCE_LIST_PER_HOST_LIMIT) return false;
      perPublication.set(publication, count + 1);
      return true;
    })
    .slice(0, SOURCE_LIST_LIMIT)
    .map(({ link, url }) => ({
      id: link.id,
      label: citationLabel(link, url),
      url: url.toString(),
      paragraphId: link.paragraphId ?? null,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "en-US"));

  return {
    status: selected.length > 0 ? "ready" : "empty",
    sources: selected,
  };
}

export function deduplicateExternalSources(
  sources: ExternalSource[],
  limit: number,
): ExternalSource[] {
  const seen = new Set<string>();
  const deduplicated: ExternalSource[] = [];

  for (const source of sources) {
    const normalized = source.url.toLocaleLowerCase("en-US");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduplicated.push(source);
    if (deduplicated.length >= limit) break;
  }

  return deduplicated;
}
