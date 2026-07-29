# Perspectica Analysis Reliability Refactor

## Goal

Make every report accurate about what was analyzed, reduce avoidable model latency, and prevent publication context from being mistaken for evidence contained in an article. The existing political compass axes and visual component remain unchanged.

## Pipeline

The live pipeline uses three parallel analysis groups:

1. **Article Lens** extracts article-grounded compass evidence and bias findings.
2. **Context Profile** performs shared publication and journalist retrieval, then produces both the political-context prior and journalist context in one structured response.
3. **Evidence Workers** perform supporting, contradicting, and background retrieval and synthesis as three smaller concurrent structured responses. Server and client validation keep sources in their highest-priority lane.

All three stages begin together. Evidence research starts from a bounded set of exact factual sentences selected deterministically from the article, so it does not wait behind Article Lens. Journalist context and evidence sections are emitted as soon as their workers finish.

If Article Lens fails, research continues from those deterministic claims while compass and bias correctly report the upstream failure.

## Political placement

Publication history and journalist work remain contextual inputs, but they cannot create an article placement or supply an axis missing from article evidence. They may only refine a placement after the article itself supplies accepted evidence on both existing axes.

Foreign-policy sanctions, embargoes, diplomatic restrictions, military trade controls, and international-organization disputes do not count as domestic economic or governance-axis evidence unless the passage separately establishes one of the adopted axis concepts.

The server emits `compass.provisional` only when Article Lens finishes before contextual research. It later emits one terminal `compass.ready` result. This removes ambiguous duplicate-ready telemetry without changing the compass UI.

## Status and failure semantics

An analysis completes as either `complete` or `partial`. The completion event includes the failed sections. An upstream Article Lens failure no longer causes claim-dependent sections to say that no evidence was verified when no research occurred.

Search failures are isolated by lane. A failed contradiction search, for example, produces an error only for Contradicting Information while successful supporting and context work remains available.

Evidence synthesis failures are isolated the same way. Each evidence worker has a smaller prompt and a lane-specific output schema, so one long or malformed response cannot erase the other two sections.

Thirty seconds is the response-time target, not a cancellation deadline. Model workers have a 90-second hard safety ceiling, allow 60 seconds for the first streamed chunk, and only consider an active stream stalled after 45 seconds without another chunk.

Empty research results carry an internal reason:

- `not-applicable`
- `no-claims`
- `no-search-results`
- `no-verified-evidence`

The UI still presents concise reader-facing language, while logs expose status, result counts, completion state, and failed sections.

## Rendering and sources

Progressive text renders a single accessible copy. Individual text chunks fade in, but the complete text is present once in the DOM so copying and text extraction cannot duplicate sentences.

Works Cited excludes corporate policies, trust pages, terms, privacy pages, newsletters, related-story modules, and other boilerplate. Same-publication links require citation-like context in the paragraph instead of merely appearing somewhere inside the article root.

## Validation

Regression coverage includes:

- Context-only and one-axis compass inputs remain unclear.
- Foreign-policy sanctions do not create economic-axis evidence.
- Lens failure still permits fallback claim research and produces a partial completion.
- Context can stream before Article Lens.
- Evidence can stream before Article Lens, and one failed search lane does not erase the others.
- Copied progressive text appears once.
- Reuters Trust Principles and same-site related-story links do not enter Works Cited.
- Combined evidence synthesis enforces mutually exclusive source assignments.
