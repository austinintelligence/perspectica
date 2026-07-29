#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DATASET_DIRECTORY = resolve(ROOT, "datasets/political-spectrum");
const DATASET_PATH = resolve(DATASET_DIRECTORY, "articles.json");
const OUTPUT_PATH = resolve(DATASET_DIRECTORY, "summary.json");

function groupCount(records, property) {
  return Object.fromEntries(
    [...new Set(records.map((record) => record[property]))]
      .sort()
      .map((value) => [value, records.filter((record) => record[property] === value).length]),
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

const dataset = JSON.parse(await readFile(DATASET_PATH, "utf8"));
const records = dataset.records;
const outletIds = [...new Set(records.map((record) => record.outletId))].sort();

const outlets = outletIds.map((outletId) => {
  const subset = records.filter((record) => record.outletId === outletId);
  return {
    outletId,
    outlet: subset[0].outlet,
    articleCount: subset.length,
    medianScore: rounded(median(subset.map((record) => record.score))),
    averageScore: rounded(
      subset.reduce((total, record) => total + record.score, 0) / subset.length,
    ),
    averageConfidence: rounded(
      subset.reduce((total, record) => total + record.confidenceScore, 0) / subset.length,
    ),
    labels: groupCount(subset, "label"),
    topics: groupCount(subset, "topic"),
    contentTypes: groupCount(subset, "contentType"),
  };
});

const summary = {
  version: dataset.version,
  generatedAt: new Date().toISOString(),
  articleCount: records.length,
  outletCount: outlets.length,
  overallMedianScore: rounded(median(records.map((record) => record.score))),
  overallAverageScore: rounded(
    records.reduce((total, record) => total + record.score, 0) / records.length,
  ),
  labels: groupCount(records, "label"),
  topics: groupCount(records, "topic"),
  contentTypes: groupCount(records, "contentType"),
  outlets,
  note: "Outlet aggregates describe this 10-article calibration sample. They are not permanent publication ratings.",
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`Wrote calibration summary to ${OUTPUT_PATH}\n`);
