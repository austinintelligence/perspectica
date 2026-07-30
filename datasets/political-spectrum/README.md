# Perspectica political-spectrum calibration dataset

This dataset supports Perspectica's article-level political-spectrum feature. It is a proof-of-concept calibration and evaluation set, not a permanent rating of any publication.

## Scope

- 100 English-language articles
- 10 articles from each of 10 publications
- Publications: The New York Times, The Hindu, The Washington Post, Al Jazeera, Fox News, BBC News, Reuters, CNN, South China Morning Post, and Associated Press
- Topic mix: government, economics, rights and society, and foreign affairs
- News, analysis, and opinion are identified separately

Associated Press is the tenth publication because the original list contained nine distinct outlets. It adds a second wire-service baseline alongside Reuters.

## Files

- `raw-articles.json` and `raw-articles.jsonl`: retrieved article corpus
- `articles.json`, `articles.jsonl`, and `articles.csv`: researched and classified calibration records
- `classification-checkpoint.json`: resumable build artifact

## Scale

|                Score | Label        |
| -------------------: | ------------ |
| -3.00 to below -2.25 | Far left     |
| -2.25 to below -1.25 | Left         |
| -1.25 to below -0.40 | Center-left  |
|  -0.40 to below 0.40 | Center       |
|         0.40 to 1.25 | Center-right |
|   Above 1.25 to 2.25 | Right        |
|   Above 2.25 to 3.00 | Far right    |

Center is a substantive result for balanced, mixed, technocratic, or minimally ideological reporting. The calibration builder does not use an `unclear` label because every dataset record receives article, publication, and research review. After live research is exhausted, the product uses these aggregate publication scores only as a low-confidence calibrated fallback. Article evidence and current research always take precedence. The live product reserves `unclear` for incomplete or failed analysis states.

## Classification method

Each record is reviewed using:

1. The current article's wording, structure, policy sympathies, source selection, and treatment of political power.
2. Independent research describing durable publication history or editorial orientation.
3. Relevant public professional work by the named journalist when available.

The current article normally contributes 65–85% of the result. Publication history normally contributes 10–25%. Journalist context normally contributes 0–15% and is zero when no relevant research was found. Publication and journalist context refine the current article; they do not replace it.

All article evidence excerpts must occur exactly in the retrieved article text. Research URLs are preserved on each record. Opinion and analysis can receive stronger placements when their own argument supports one; straight news may remain Center even when its publication has a documented historical leaning.

## Validation and collection

Run these commands from the repository root:

```sh
pnpm dataset:spectrum:collect
pnpm dataset:spectrum:validate
pnpm dataset:spectrum:summarize
```

The committed classified records are the reviewed calibration artifact used by
the product. `dataset:spectrum:collect` is an optional maintainer tool for
refreshing the raw public corpus; it uses a local Exa key and does not run inside
the extension. A new classification set must be reviewed and committed before it
replaces the current records.

## Limitations

The corpus is deliberately broad but small. Search indexing, publisher access controls, and article text availability vary by outlet. Historical publication assessments can also disagree. The dataset should be used to tune prompts, scoring thresholds, and regression tests—not to infer that every article from a publication shares the same politics.
