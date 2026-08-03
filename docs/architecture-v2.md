# Perspectica V2 architecture

V2 is a self-contained Manifest V3 extension. It has no Perspectica backend, hosted database,
local server, or telemetry endpoint.

## Runtime boundaries

```text
side panel
  -> reconnectable runtime port + request/response messages
service worker
  -> article extraction in the active tab
  -> IndexedDB event/log journal and chrome storage ownership
offscreen document
  -> Article Lens + AnalysisPlan + RetrievalCoordinator + report projection
  -> ChatGPT model bridge or Exa fetch bridge
```

The implementation intentionally keeps the pipeline in the offscreen document. A dedicated
extension worker was not introduced because the current ChatGPT provider and Chrome credential
bridge are available in the offscreen context, while moving them to a second worker would add a
new RPC boundary without a compatibility proof. Authentication and secret storage boundaries are
not weakened to make that move.

## Analysis flow

1. The extractor returns one bounded `ArticleDocument` and the intelligence package builds one
   deterministic `ArticleIndex` with paragraph, sentence, entity, quantity, date, link, and claim
   seed IDs.
2. The Article Lens receives a compact index spine plus scored passages. It returns a validated,
   adaptive `AnalysisPlan`; malformed or unavailable model output falls back to the deterministic
   plan, not to a legacy multi-agent dossier.
3. One `RetrievalCoordinator` schedules bounded missions against a shared `EvidenceLedger`.
   Fast, balanced, and deep modes control context, mission, source, concurrency, deadline, and
   model-output limits.
4. Providers return only bounded `EvidenceCandidate` discovery records. A provider never assigns a
   claim, relationship, reader-facing statement, or context signal. One bounded adjudication step
   maps exact candidate IDs to planned claims and relationships; the centralized validator then
   checks mission/claim boundaries, canonical provenance, claim anchors, source excerpts, source
   kind, and context-subject identity before the `EvidenceLedger` can create an assertion.
   Source text requires an exact excerpt match. Search summaries cannot establish support,
   contradiction, or qualification and cannot be rendered as quotations. The current article is
   always rejected as its own independent source.
5. Perspective and report sections are projected from the same validated ledger. Article-owned
   framing remains the compass anchor; accepted publication, journalist, comparable-coverage, and
   topic-context signals may provide a bounded contextual refinement. Contradicting or qualifying
   sources are claimed first, then supporting sources, then additional context, so one source is
   not silently duplicated across lanes.

The intelligence package also exposes `retryMissingSections`. It reuses the existing index, plan,
accepted sources, and graph, then reruns only missions that can serve requested sections whose
provider lane actually failed; an honestly completed empty lane is not treated as a retry failure.
It never restarts the full article run.

Pipeline phases are explicit: `indexed`, `planning`, `retrieving`, `adjudicating`, `composing`,
and a terminal `complete`, `partial`, `failed`, or `cancelled` phase. Section applicability is
part of the plan; empty or not-applicable sections are rendered as honest states.

## Retrieval policy

Exa is a bounded search provider. Its response text/highlights are carried as candidate discovery
content and can become `source-text` evidence only after adjudication and exact-excerpt validation.
Results are cached by canonical query and mission shape for 24 hours. Native ChatGPT search
summaries use a separate 30-minute cache because their search index can change more quickly.

Native ChatGPT research is one global web-search workflow for the whole plan. It does not launch
one model read per URL or round-robin URLs into missions. URL-attributed results are stored as
`search-summary` candidates with no quoteable excerpt; they can only become clearly labeled
context/search-summary assertions when the adjudicator and validator support that use.

## Auth and storage

Login with ChatGPT remains the sole account/authentication path. The existing device flow,
refresh-token vault, `chrome.storage.session` access tokens, origin permission checks, disconnect
cleanup, and sender validation remain in the service-worker boundary. Exa's key is an optional
encrypted provider secret; it is not an auth provider or account identity.

Jobs and event payloads are bounded. `chrome.storage.local` retains preferences and the compact
job snapshot. IndexedDB `perspectica-analysis-v2` stores append-only event envelopes and bounded
logs. Event delivery appends the envelope before advancing the job cursor; same-sequence retries
are idempotent and sequence gaps are rejected. New jobs keep `events: []`; the side panel asks
`analysis.getEventsSince(jobId, sequence)` in pages, requires contiguous sequences, and replays
the missing range after reconnect before applying live deltas. `perspectica-analysis-artifacts-v1`
keeps only the current run's bounded index/plan/ledger snapshot for 24 hours so a targeted retry
can survive an offscreen document restart; it contains no credentials. A healthy port does not
use polling.

## Side-panel projection

The side panel owns a custom `ReportStore` whose state is section-isolated. Each `section.ready`
event replaces only that section snapshot, while metadata, progress, source list, and terminal
status remain separate fields. The rendered report sections subscribe to their own snapshots, so
progress and ledger counters do not reconcile or rerender every evidence section. The UI never
merges, reorders, or reconciles evidence assertions. Motion is limited to CSS opacity/height
transitions and respects reduced-motion preferences; report text is inserted as complete bounded
nodes rather than animated per word.

## Verification and measured baseline

The benchmark is a structural build/regression check, not proof of live provider latency, token
usage, first-grounded-result time, DOM rerender count, or reader-facing quality. No authenticated
provider run is implied by this table. Run `pnpm bench:v2` and `pnpm test` to refresh the local
snapshot:

| Measurement        |                              Before V2 |              V2 target/measurement |
| ------------------ | -------------------------------------: | ---------------------------------: |
| Unit tests         |                            205 passing |        107 passing across 25 files |
| Test wall time     |                                 9.16 s |            local command dependent |
| Typecheck          |                                passing |                            passing |
| Production build   |                                1.23 MB |                    1,142,549 bytes |
| Build JavaScript   |                                    n/a |                    1,037,000 bytes |
| Build CSS          |                                    n/a |                       25,146 bytes |
| Build files        |                                    n/a |                                 15 |
| Source files       |                                    n/a |                                102 |
| Legacy production  |                                    n/a |                              false |
| Production engines | six specialist/legacy package surfaces | one Article Lens + one coordinator |

`pnpm bench:v2` reports current unpacked build bytes, JavaScript/CSS bytes, source file counts,
and whether removed legacy packages are present in production sources. Those numbers describe
the packaged surface only; performance and evidence quality require authenticated end-to-end
measurements and adversarial source/claim fixtures.

## Known limits

- Native ChatGPT URL sources are search summaries, not independent page transcripts; they cannot
  support, contradict, or qualify a claim or support verbatim quotations without an independently
  retrieved source-text candidate.
- Exa result text is provider-returned text/highlights, not a browser re-read of the page. It is
  still only a candidate until the bounded adjudicator and centralized validator accept it.
- Article compass and bias signals are bounded article-owned heuristics when the lens model is
  unavailable; they are not permanent publisher or person labels.
- Chrome can suspend or deny access to protected pages. The extractor reports that boundary rather
  than attempting to bypass it.
