export interface PublicationCalibrationPrior {
  publication: string;
  score: number;
  sampleSize: number;
  generatedAt: string;
}

// Generated from datasets/political-spectrum/summary.json. These are weak,
// last-resort priors from a 10-article sample, not permanent outlet ratings.
const CALIBRATION_PRIORS: Record<string, PublicationCalibrationPrior> = {
  "al jazeera": {
    publication: "Al Jazeera",
    score: -0.25,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "associated press": {
    publication: "Associated Press",
    score: -0.25,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "ap news": {
    publication: "Associated Press",
    score: -0.25,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "bbc news": {
    publication: "BBC News",
    score: -0.15,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  bbc: {
    publication: "BBC News",
    score: -0.15,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  cnn: {
    publication: "CNN",
    score: -0.5,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "fox news": {
    publication: "Fox News",
    score: 0.925,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  reuters: {
    publication: "Reuters",
    score: -0.32,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "south china morning post": {
    publication: "South China Morning Post",
    score: 0.2,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  scmp: {
    publication: "South China Morning Post",
    score: 0.2,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "the hindu": {
    publication: "The Hindu",
    score: -0.125,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "the new york times": {
    publication: "The New York Times",
    score: -0.6,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "new york times": {
    publication: "The New York Times",
    score: -0.6,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "the washington post": {
    publication: "The Washington Post",
    score: -0.625,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
  "washington post": {
    publication: "The Washington Post",
    score: -0.625,
    sampleSize: 10,
    generatedAt: "2026-07-29",
  },
};

function normalizePublication(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function publicationCalibrationPrior(
  publication: string | null | undefined,
): PublicationCalibrationPrior | null {
  if (!publication?.trim()) return null;
  const normalized = normalizePublication(publication);
  const exact = CALIBRATION_PRIORS[normalized];
  if (exact) return exact;

  const match = Object.entries(CALIBRATION_PRIORS).find(
    ([name]) => normalized.includes(name) || name.includes(normalized),
  );
  return match?.[1] ?? null;
}
