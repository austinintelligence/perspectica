#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DATASET_PATH = resolve(ROOT, "datasets/political-spectrum/articles.json");
const EXPECTED_OUTLETS = 10;
const EXPECTED_PER_OUTLET = 10;
const EXPECTED_TOTAL = EXPECTED_OUTLETS * EXPECTED_PER_OUTLET;

const LABELS = ["far-left", "left", "center-left", "center", "center-right", "right", "far-right"];

function expectedLabel(score) {
  if (score < -2.25) return "far-left";
  if (score < -1.25) return "left";
  if (score < -0.4) return "center-left";
  if (score < 0.4) return "center";
  if (score <= 1.25) return "center-right";
  if (score <= 2.25) return "right";
  return "far-right";
}

function normalize(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dataset = JSON.parse(await readFile(DATASET_PATH, "utf8"));
const records = dataset.records;
assert(Array.isArray(records), "Dataset records must be an array.");
assert(
  records.length === EXPECTED_TOTAL,
  `Expected ${EXPECTED_TOTAL} records; found ${records.length}.`,
);

const ids = new Set();
const byOutlet = new Map();
const distribution = new Map(LABELS.map((label) => [label, 0]));

for (const record of records) {
  assert(!ids.has(record.id), `Duplicate record id: ${record.id}`);
  ids.add(record.id);
  assert(LABELS.includes(record.label), `Invalid label for ${record.id}: ${record.label}`);
  assert(record.label === expectedLabel(record.score), `Score/label mismatch for ${record.id}.`);
  assert(record.score >= -3 && record.score <= 3, `Out-of-range score for ${record.id}.`);
  assert(
    record.confidenceScore >= 0 && record.confidenceScore <= 1,
    `Invalid confidence for ${record.id}.`,
  );
  assert(record.researchComplete === true, `Research was not completed for ${record.id}.`);
  assert(/^https?:\/\//u.test(record.url), `Invalid article URL for ${record.id}.`);

  const influence =
    record.articleInfluence + record.publicationInfluence + record.journalistInfluence;
  assert(Math.abs(influence - 1) <= 0.011, `Influence weights do not total 1 for ${record.id}.`);

  const articleText = normalize(record.text);
  for (const evidence of record.articleEvidence) {
    assert(
      articleText.includes(normalize(evidence.excerpt)),
      `Ungrounded article excerpt for ${record.id}: ${evidence.excerpt}`,
    );
  }
  for (const source of [...record.publicationSources, ...record.journalistSources]) {
    assert(/^https?:\/\//u.test(source.url), `Invalid research URL for ${record.id}.`);
  }

  byOutlet.set(record.outletId, (byOutlet.get(record.outletId) ?? 0) + 1);
  distribution.set(record.label, distribution.get(record.label) + 1);
}

assert(
  byOutlet.size === EXPECTED_OUTLETS,
  `Expected ${EXPECTED_OUTLETS} outlets; found ${byOutlet.size}.`,
);
for (const [outlet, count] of byOutlet) {
  assert(
    count === EXPECTED_PER_OUTLET,
    `${outlet} has ${count} records instead of ${EXPECTED_PER_OUTLET}.`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: "valid",
      records: records.length,
      outlets: Object.fromEntries([...byOutlet].sort()),
      labels: Object.fromEntries(distribution),
    },
    null,
    2,
  )}\n`,
);
