# Perspectica Performance and Density Refinement

## Design read

Perspectica is an editorial news-reading side panel for readers who want a fast, grounded second view of an article. This refinement preserves the cream and green visual language, plain-text sections, and single expandable political spectrum. It reduces waiting and scrolling without turning the extension into a dashboard.

Design dials:

- Design variance: 4
- Motion intensity: 4
- Visual density: 3

## Goals

- Show useful sections sooner and keep every research lane independent.
- Share the same compact article and claim context across evidence workers.
- Bound model retries, time, prompt size, source count, and visible response length.
- Keep source traceability and exact excerpt verification.
- Make the side panel easier to scan at narrow widths.
- Add subtle motion for hierarchy, loading, and state changes.
- Preserve the current product scope and five analysis outputs.

## Execution design

The first three events remain immediate: analysis metadata, article metadata, and works cited.

Journalist Context starts at the same time as Article Lens because it only needs the byline and article topic. Article Lens continues to produce political spectrum evidence, bias candidates, and researchable claims. Once its claims are ready, Supporting Information, Contradicting Information, and Additional Context start together.

Each lane settles independently and streams as soon as it is ready. The slowest or failed lane does not block completed lanes.

```text
metadata + works cited
        |
        +---- journalist search -> journalist synthesis
        |
        +---- Article Lens -> spectrum + bias
                          |
                          +---- supporting search -> synthesis
                          +---- contradicting search -> synthesis
                          +---- context search -> synthesis
```

## Shared research brief

Research workers receive a compact immutable brief instead of the full extracted article. It contains:

- title, author, publication, date, canonical URL, content type, and article domain
- up to four important claims
- compact claim text and query hints
- one precomputed query-term string
- one pre-serialized model context shared by the evidence lanes

The journalist lane excludes no publication domain so it can find the journalist's other work at the same outlet. Evidence lanes continue to exclude the article's own domain so the article cannot verify itself.

## Model and search budgets

Article Lens:

- analyze at most 24,000 article characters
- prefer no more than two bias findings and four research claims
- one bounded retry for transient provider errors
- a total AI SDK timeout
- explicit concise explanation and excerpt instructions

Research workers:

- no more than two supporting sources
- no more than two contradicting sources
- no more than two journalist findings
- no more than one additional-context source
- summaries limited to roughly two sentences
- relationship explanations limited to one sentence
- exact excerpts limited to a short passage
- smaller retrieved-source context per result
- one bounded retry and a total AI SDK timeout

Exa remains the retrieval provider. Identical requests are coalesced and cached for a short bounded period to make repeat analyses faster. Aborted and failed searches are never cached.

## Failure behavior

- Every section returns a ready, empty, or failed event exactly once.
- Article Lens failure does not cancel journalist research.
- A research failure does not cancel another lane.
- User cancellation stops pending search and model work.
- Stale streamed events from a cancelled analysis cannot update a newer report.
- Development Strict Mode cannot launch two simultaneous analyses.

## Interface refinement

The article header remains at the top of the report and scrolls away normally. The political spectrum remains the only disclosure.

Changes:

- use a local system sans stack with an editorial system serif for article titles
- reduce paragraph, source, and section spacing
- make section titles semantic headings with accessible labels
- make sources compact citations instead of long repeated blocks
- keep excerpts visible, but make the generated excerpts shorter at the source
- make the compass fluid at narrow side-panel widths
- enlarge the compass marker hit area without enlarging the visual point
- add visible focus states
- add restrained entry, hover, active, loading, and disclosure transitions
- honor reduced-motion preferences

Motion communicates state only: streamed sections settle into place, the compass control responds to expansion, links and buttons provide feedback, and the placement point appears once.

## Validation

- Orchestrator tests for early journalist start, completion order, failure isolation, and terminal events
- Research tests for compact prompts, source limits, same-publication journalist search, and exact excerpt verification
- Exa tests for coalescing, bounded caching, abort behavior, and failure eviction
- Report-state tests for stale events and out-of-order completion
- Type checking, unit tests, extension build, API build, and formatting
- Visual checks at narrow and standard side-panel widths
- Keyboard focus and reduced-motion review
