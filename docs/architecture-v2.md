# Perspectica V2 intelligence and event model

This document describes the merged V2 intelligence graph. The broader extension/runtime boundary
is documented in [`architecture.md`](architecture.md).

## Stable contracts

- `ResearchDepth`: `quick | balanced | deep | verified`
- `EvidenceProvider`: `free | chatgpt | exa`
- `PipelineEvent`: the only analysis stream
- `AnalysisEnvelope`: protocol, job identity, owner token, revision, sequence, and one event
- `EvidenceCandidate`: discovery provenance and bounded content, never a claim assignment
- `EvidenceLedger`: validated sources, assertions, context signals, mission status, and rejection
  reasons

Legacy `fast` preferences are accepted only during migration and normalize to `quick`. The removed
V1 analysis, compass, and validation packages are not runtime dependencies.

## Pipeline phases and reader projection

Internal phases are `indexed`, `planning`, `retrieving`, `adjudicating`, and `composing`, followed
by `complete`, `partial`, `failed`, or `cancelled`. The UI derives four reader phases without a
second progress protocol:

| V2 event or phase              | Reader phase      |
| ------------------------------ | ----------------- |
| extraction / `article.indexed` | Reading article   |
| `planning`                     | Planning research |
| `retrieving`, `adjudicating`   | Checking sources  |
| `composing`                    | Preparing report  |

Source and section counts come from `research.progress`, `ledger.updated`, and `section.ready`.
No timer fabricates progress or percentages.

`section.failed` is the section-isolated failure signal. It identifies a retryable report lane
without terminating the stream; the terminal `analysis.completed` event still records whether the
overall run completed fully or partially. The UI retains completed sections and offers targeted
retry for only the failed lane.

## Locked research profiles

| Depth    | Preferred inference | Reasoning | Missions | Sources | Model calls | Soft target | Hard ceiling |
| -------- | ------------------- | --------- | -------: | ------: | ----------: | ----------: | -----------: |
| Quick    | GPT-5.4             | Low       |        1 |       2 |           2 |         15s |          90s |
| Balanced | GPT-5.6 Luna        | Medium    |        3 |       5 |           3 |         30s |         180s |
| Deep     | GPT-5.6 Luna        | High      |        5 |       8 |           5 |         60s |         360s |
| Verified | GPT-5.6 Sol         | High      |        8 |      12 |           6 |        120s |         600s |

Account capability checks can produce a visible fallback model. Advanced overrides label the
configuration Custom while retaining the chosen profile's orchestration ceiling. The analysis
fingerprint includes profile, model, reasoning, provider and provider scope, extraction version,
intelligence version, and prompt version; a differently budgeted report is never silently reused.

## Retrieval and validation

Free discovery uses bounded public endpoints and public-page reads. ChatGPT discovery uses the
connected account's supported tool. Exa uses the reader's encrypted API key. Routing is by
capability, and fallback is ChatGPT/Exa → Free → article-only. Search summaries can help discover
pages but cannot support, contradict, qualify, or provide a quotation.

The validator rejects:

- candidates outside the planned mission;
- the current article as independent evidence;
- relationship assignments made by a provider;
- source text without an exact excerpt match;
- unsafe, model-invented, or unfetched URLs;
- publication/journalist context with the wrong subject identity;
- duplicate assertions or sources already assigned to a stronger lane.

Contradicting/qualifying evidence is allocated first, then supporting evidence, then additional
context. Deterministic projection prunes reader copy whose citations were removed and replaces a
mixed unsupported synthesis lead rather than leaving it to describe rejected claims.

## Replay and targeted retry

The service worker journals encrypted envelopes with monotonic sequences. A healthy port receives
live deltas; reconnect fetches only missing pages and validates continuity. No healthy-port polling
or full event-ring rewrite occurs. A section retry keeps the same analysis/job identity and reuses
compatible artifacts while changing the owner token for the new bounded execution.

Completed/partial V2 reports replay across panel and service-worker restarts. Incompatible active
V1 jobs are marked interrupted with Restart; V1 event bodies are never interpreted as V2 events.

## Measurement boundary

`pnpm verify:release`, `pnpm bench:v2`, and the scripts under `scripts/benchmarks/` measure tests,
package structure, bundle bytes, source/dependency counts, manifest/CSP rules, and deterministic
orchestration. They do not prove authenticated provider latency, Chrome memory/CPU, or evidence
quality. Those claims require a separately recorded browser/provider run.
