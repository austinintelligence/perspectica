#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIRECTORY = resolve(ROOT, "datasets/political-spectrum");
const ENV_PATH = resolve(ROOT, ".env.local");
const START_DATE = process.env.SPECTRUM_DATASET_START_DATE ?? "2026-06-15T00:00:00.000Z";
const END_DATE = process.env.SPECTRUM_DATASET_END_DATE ?? "2026-07-30T00:00:00.000Z";
const RESULTS_PER_QUERY = 8;
const ARTICLES_PER_OUTLET = 10;

const OUTLETS = [
  {
    id: "new-york-times",
    name: "The New York Times",
    domain: "nytimes.com",
    allowedHosts: ["www.nytimes.com"],
  },
  {
    id: "the-hindu",
    name: "The Hindu",
    domain: "thehindu.com",
    allowedHosts: ["www.thehindu.com"],
  },
  {
    id: "washington-post",
    name: "The Washington Post",
    domain: "washingtonpost.com",
    allowedHosts: ["www.washingtonpost.com"],
  },
  {
    id: "al-jazeera",
    name: "Al Jazeera",
    domain: "aljazeera.com",
    allowedHosts: ["www.aljazeera.com"],
  },
  {
    id: "fox-news",
    name: "Fox News",
    domain: "foxnews.com",
    allowedHosts: ["www.foxnews.com"],
  },
  {
    id: "bbc-news",
    name: "BBC News",
    domain: "bbc.com",
    allowedHosts: ["www.bbc.com"],
  },
  {
    id: "reuters",
    name: "Reuters",
    domain: "reuters.com",
    allowedHosts: ["www.reuters.com"],
  },
  {
    id: "cnn",
    name: "CNN",
    domain: "cnn.com",
    allowedHosts: ["www.cnn.com"],
  },
  {
    id: "south-china-morning-post",
    name: "South China Morning Post",
    domain: "scmp.com",
    allowedHosts: ["www.scmp.com"],
  },
  {
    id: "associated-press",
    name: "Associated Press",
    domain: "apnews.com",
    allowedHosts: ["apnews.com"],
  },
];

const TOPICS = [
  {
    id: "government",
    quota: 3,
    query:
      "recent political reporting about government, elections, political parties, legislation, courts, or executive power",
  },
  {
    id: "economics",
    quota: 2,
    query:
      "recent political reporting about taxes, trade, labor, regulation, public spending, inequality, business, or economic policy",
  },
  {
    id: "rights-and-society",
    quota: 2,
    query:
      "recent political reporting about civil rights, immigration, health care, education, religion, climate policy, or social policy",
  },
  {
    id: "foreign-affairs",
    quota: 3,
    query:
      "recent political reporting about diplomacy, war, national security, international institutions, alliances, sanctions, or foreign policy",
  },
];
const FALLBACK_TOPICS = [
  {
    id: "government",
    quota: 0,
    query:
      "politics analysis about the White House, Congress, courts, elections, public policy, or political institutions",
  },
  {
    id: "foreign-affairs",
    quota: 0,
    query:
      "political reporting about United States foreign policy, diplomacy, China, Europe, the Middle East, Russia, or international institutions",
  },
  {
    id: "economics",
    quota: 0,
    query:
      "political reporting about tariffs, taxes, trade, regulation, labor, public spending, inequality, or economic policy",
  },
];

function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        key.startsWith("utm_") ||
        key === "output" ||
        key === "cid" ||
        key === "ocid" ||
        key === "cmpid"
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

function looksEnglish(value) {
  const compact = value.replace(/\s/gu, "");
  if (!compact) return false;
  const latin = compact.match(/[A-Za-z0-9.,:;!?'"’“”()\-–—$%&/]/gu)?.length ?? 0;
  return latin / compact.length >= 0.72;
}

function isLikelyArticle(result, outlet) {
  const url = canonicalUrl(result.url);
  if (!url) return false;
  const parsed = new URL(url);
  if (!outlet.allowedHosts.includes(parsed.hostname)) return false;
  const path = parsed.pathname.toLowerCase();
  if (
    path === "/" ||
    /\/(video|videos|audio|podcast|podcasts|newsletter|newsletters|author|authors|profile|profiles|about|contact|tag|topic|topics|section|column|default|live|liveblog|live-news|interactive)(\/|$)/u.test(
      path,
    )
  ) {
    return false;
  }
  const title = String(result.title ?? "").trim();
  const text = String(result.text ?? "").trim();
  const nonPolitical = /\b(world cup|soccer|football|cricket|nba|nfl|nhl|mlb|tennis|golf)\b/iu;
  const politicalSignal =
    /\b(politic|government|president|prime minister|minister|parliament|congress|senate|supreme court|court|election|vote|voting|party|policy|law|bill|rights|immigration|tariff|tax|regulation|labor|inequality|public spending|social care|police|military|war|security|diplomacy|sanction|alliance|ukraine|russia|iran|israel|gaza|china|climate|education)\w*/iu;
  return (
    title.length >= 12 &&
    text.length >= 500 &&
    looksEnglish(title) &&
    !nonPolitical.test(`${title} ${path}`) &&
    politicalSignal.test(`${title} ${path} ${text.slice(0, 2_500)}`)
  );
}

function inferContentType(result) {
  const haystack = `${result.url} ${result.title}`.toLowerCase();
  if (/\b(opinion|editorial|commentary|column|analysis)\b/u.test(haystack)) {
    return /\banalysis\b/u.test(haystack) ? "analysis" : "opinion";
  }
  return "news";
}

function normalizedResult(outlet, topic, result) {
  const url = canonicalUrl(result.url);
  const urlHash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return {
    id: `${outlet.id}-${topic.id}-${urlHash}`,
    outletId: outlet.id,
    outlet: outlet.name,
    domain: outlet.domain,
    topic: topic.id,
    title: String(result.title ?? "").trim(),
    url,
    author: String(result.author ?? "").trim() || null,
    publishedAt: String(result.publishedDate ?? "").trim() || null,
    contentType: inferContentType(result),
    text: String(result.text ?? "")
      .trim()
      .slice(0, 16_000),
    highlights: Array.isArray(result.highlights)
      ? result.highlights
          .map((highlight) => String(highlight).trim())
          .filter(Boolean)
          .slice(0, 5)
      : [],
    exaScore: typeof result.score === "number" ? result.score : null,
    collectedAt: new Date().toISOString(),
  };
}

async function exaSearch(
  apiKey,
  outlet,
  topic,
  { numResults = RESULTS_PER_QUERY, startPublishedDate = START_DATE } = {},
) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query: `${outlet.name}: ${topic.query}. Return English-language reporting.`,
        type: "auto",
        numResults,
        includeDomains: [outlet.domain],
        startPublishedDate,
        endPublishedDate: END_DATE,
        contents: {
          text: { maxCharacters: 16_000 },
          highlights: { numSentences: 3, highlightsPerUrl: 3 },
        },
      }),
    });
    if (response.status !== 429 || attempt === 3) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100 * (attempt + 1)));
  }

  if (!response?.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(`${outlet.name}/${topic.id}: Exa ${response.status} ${detail}`);
  }

  const payload = await response.json();
  return (Array.isArray(payload.results) ? payload.results : [])
    .filter((result) => isLikelyArticle(result, outlet))
    .map((result) => normalizedResult(outlet, topic, result));
}

function resultRank(result) {
  const published = result.publishedAt ? Date.parse(result.publishedAt) : 0;
  const recency = Number.isFinite(published) ? published / 1e13 : 0;
  const textCoverage = Math.min(result.text.length / 8_000, 1);
  return (result.exaScore ?? 0) + recency * 0.02 + textCoverage * 0.08;
}

function selectBalancedArticles(candidates) {
  const selected = [];
  const used = new Set();
  const ranked = [...candidates].sort((a, b) => resultRank(b) - resultRank(a));

  for (const topic of TOPICS) {
    const topicCandidates = ranked.filter((candidate) => candidate.topic === topic.id);
    for (const candidate of topicCandidates.slice(0, topic.quota)) {
      if (!candidate.url || used.has(candidate.url)) continue;
      selected.push(candidate);
      used.add(candidate.url);
    }
  }

  for (const candidate of ranked) {
    if (selected.length >= ARTICLES_PER_OUTLET) break;
    if (!candidate.url || used.has(candidate.url)) continue;
    selected.push(candidate);
    used.add(candidate.url);
  }

  return selected.slice(0, ARTICLES_PER_OUTLET);
}

async function collectOutlet(apiKey, outlet) {
  const settlements = await Promise.allSettled(
    TOPICS.map((topic) => exaSearch(apiKey, outlet, topic)),
  );
  const candidates = [];
  const errors = [];

  settlements.forEach((settlement, index) => {
    if (settlement.status === "fulfilled") {
      candidates.push(...settlement.value);
    } else {
      errors.push({
        topic: TOPICS[index]?.id ?? "unknown",
        message:
          settlement.reason instanceof Error
            ? settlement.reason.message
            : String(settlement.reason),
      });
    }
  });

  let articles = selectBalancedArticles(candidates);
  for (const fallbackTopic of FALLBACK_TOPICS) {
    if (articles.length >= ARTICLES_PER_OUTLET) break;
    try {
      candidates.push(
        ...(await exaSearch(apiKey, outlet, fallbackTopic, {
          numResults: 10,
          startPublishedDate: "2025-07-01T00:00:00.000Z",
        })),
      );
      articles = selectBalancedArticles(candidates);
    } catch (error) {
      errors.push({
        topic: `fallback-${fallbackTopic.id}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    outlet,
    articles,
    errors,
    candidateCount: candidates.length,
  };
}

async function main() {
  const fileEnv = parseEnv(await readFile(ENV_PATH, "utf8"));
  const apiKey = process.env.EXA_API_KEY?.trim() || fileEnv.EXA_API_KEY?.trim();
  if (!apiKey) throw new Error(`EXA_API_KEY is missing from ${ENV_PATH}`);

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const outletResults = [];

  for (const outlet of OUTLETS) {
    process.stdout.write(`Collecting ${outlet.name}… `);
    const result = await collectOutlet(apiKey, outlet);
    outletResults.push(result);
    process.stdout.write(
      `${result.articles.length} selected from ${result.candidateCount} candidates\n`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
  }

  const articles = outletResults.flatMap((result) => result.articles);
  const manifest = {
    version: "2026-07-29.1",
    generatedAt: new Date().toISOString(),
    startPublishedDate: START_DATE,
    endPublishedDate: END_DATE,
    targetArticles: OUTLETS.length * ARTICLES_PER_OUTLET,
    articleCount: articles.length,
    outlets: outletResults.map((result) => ({
      id: result.outlet.id,
      name: result.outlet.name,
      domain: result.outlet.domain,
      selected: result.articles.length,
      candidates: result.candidateCount,
      errors: result.errors,
    })),
    articles,
  };

  await writeFile(
    resolve(OUTPUT_DIRECTORY, "raw-articles.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    resolve(OUTPUT_DIRECTORY, "raw-articles.jsonl"),
    `${articles.map((article) => JSON.stringify(article)).join("\n")}\n`,
  );

  process.stdout.write(`Wrote ${articles.length} articles to ${OUTPUT_DIRECTORY}\n`);
  if (articles.length !== manifest.targetArticles) {
    process.exitCode = 2;
  }
}

await main();
