# Perspectica Build Plan

> The political-spectrum portions of this plan are superseded by
> `2026-07-29-seven-position-spectrum-design.md`. Other implementation phases
> remain useful as historical build context.

Status: Adopted
Date: July 28, 2026
Product source: team product-design document (kept outside the public repository)

## Build progress

- Phase 0: completed in the initial build slice.
- Phase 1: completed as a deterministic local vertical slice.
- Phase 2: core implementation completed; prompt-variant evaluation remains.
- Phase 3: next milestone.
- Phase 4: encrypted login-session storage completed; report storage remains.
- Phase 5: planned.

## Objective

Build a proof-of-concept Chrome side-panel extension that analyzes the active news article and progressively renders:

1. Political Spectrum
2. Bias
3. Journalist Context
4. Supporting Information
5. Contradicting Information
6. Additional Context when needed
7. The article's Works Cited

The proof of concept is successful when a developer can load the extension in Chrome, open a supported article, start one analysis, see every heading immediately, watch validated sections arrive, expand the Political Spectrum, inspect evidence and links, and repeat the same flow using a deterministic demo provider without external API keys.

## Fixed product decisions

- TypeScript end to end.
- pnpm workspace with a modular-monolith backend.
- WXT, React, and Chrome Manifest V3 for the extension.
- Next.js route handlers on the Node.js runtime for the backend.
- Vercel AI SDK 7 and Zod for AI orchestration and structured output.
- A consent-first Login with ChatGPT device flow for the POC's live model access.
- SQLite and Drizzle ORM for the POC database.
- One vertically scrolling, text-first side-panel report.
- Political Spectrum is the only expandable section.
- Works Cited is produced deterministically from inline article citations.
- Political placement is calculated deterministically from verified article evidence.
- Research sources remain separate from original article sources.
- AI results are streamed at validated section boundaries.
- ChatGPT tokens remain inside the backend authentication boundary and are encrypted at
  rest.

## Success criteria

### Functional

- The content script extracts headline, byline, publication, date, canonical URL, ordered paragraphs, quotations, and links from a typical article page.
- The side panel requests extraction from the active tab and submits a valid `AnalyzeRequest`.
- `/api/analyze` returns typed stream events in the adopted section order.
- The side panel requires a connected ChatGPT session in live mode.
- The server dynamically selects a Codex model exposed by the connected account.
- The extension renders partial completion and preserves completed sections when a later section fails.
- The compass displays the adopted axes:
  - x: Social equality (-1) to Economic liberty (+1)
  - y: Authority (-1) to Self-determination (+1)
- Exact excerpt validation prevents unsupported article evidence from affecting compass or bias results.
- Selected article citations appear only in Works Cited.
- External research links appear only in Journalist Context, Supporting, Contradicting, or Additional Context.

### Quality

- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- Shared schemas are the only contract between extension and backend.
- Core analysis logic is framework-independent and unit tested.
- The application runs in an explicit demo mode without model or search credentials.
- Real AI and search adapters are isolated behind interfaces and can be enabled by environment variables.
- Prompt and model versions are included in stored analysis metadata.

## Repository architecture

```text
apps/
  api/                 Next.js route handlers and backend composition root
  extension/           WXT React extension
packages/
  contracts/           Zod schemas and inferred TypeScript types
  extraction/          Browser-safe article extraction
  compass/             Deterministic political evidence scoring
  validation/          Excerpt, URL, source, and section validation
  analysis/            Pipeline orchestration and provider interfaces
  storage/             Drizzle schema and SQLite repository
  test-fixtures/       Synthetic articles and expected results
docs/
  plans/               Adopted product and implementation plans
```

Dependency direction:

```text
contracts
  ↑
extraction  compass  validation  storage
       \       |       /       /
              analysis
                 ↑
          api composition

contracts + extraction
          ↑
      extension
```

The extension never imports backend implementation code. Domain packages do not import Next.js, React, WXT, or provider SDKs.

## ChatGPT connection

The POC uses the community `opencoredev/login-with-chatgpt` device-code flow. The side panel
shows a short consent explanation before starting login and displays the one-time code while
the OpenAI authorization page is open.

The server owns the complete credential boundary:

1. The extension sends credentialed requests only to `/api/chatgpt/*`.
2. The API sets a signed, HttpOnly, Secure, SameSite=None session cookie.
3. The extension never receives access or refresh tokens.
4. The handler encrypts refreshable token material before the SQLite store receives it.
5. Raw token export stays disabled.
6. The analysis route uses a request-bound proxy fetch, so AI SDK can call the Codex
   Responses API without application code reading bearer tokens.
7. Logout deletes the server session and expires the browser cookie.

The extension manifest has a committed public key and therefore a stable local extension ID.
The API accepts credentialed browser requests only from that exact origin. Production uses an
HTTPS API, an environment-provided encryption secret, an exact deployed extension origin,
short session TTLs, and the same visible disconnect control.

## Core contracts

### Article input

- `ArticleDocument`
  - canonical URL
  - title
  - author
  - publication
  - publication date
  - detected language
  - ordered paragraphs with stable IDs
  - quotation attribution when available
  - original links and citations
  - extraction metadata

### Analysis result

- `AnalysisMetadata`
- `CompassResult`
- `BiasResult`
- `JournalistContextResult`
- `EvidenceSection`
- `SourceListResult`
- `AnalysisReport`
- `AnalysisEvent`

Completed domain results carry a status of `ready` or `empty`; the extension state layer adds `waiting`, `loading`, and `error`. Every sourced finding carries a URL and provenance. Every article evidence finding carries a paragraph ID and exact excerpt.

## Political Spectrum implementation

### Evidence item

Each candidate contains:

- political issue family
- paragraph ID
- exact excerpt
- speaker
- whether the article endorses the position
- axis
- direction
- strength from 0 to 1
- relevance from 0 to 1
- explanation

### Validation

1. Normalize whitespace and punctuation.
2. Confirm the excerpt is contained in the referenced paragraph.
3. Confirm the evidence represents the article's framing or endorsed position.
4. Drop invalid evidence.
5. Require evidence for both axes before returning a point.

### Calculation

For every accepted item:

```text
weight = strength * relevance
axis score = sum(direction sign * weight) / sum(weight)
```

- Social equality = negative x
- Economic liberty = positive x
- Authority = negative y
- Self-determination = positive y
- Final values are clamped to `[-1, 1]`

Labels:

- x < 0 and y > 0: Left-libertarian
- x > 0 and y > 0: Market-liberal
- x < 0 and y < 0: Democratic-socialist
- x > 0 and y < 0: Conservative
- both absolute values below the center threshold: Mixed / near center
- insufficient validated evidence: Unclear

Confidence combines evidence count, issue-family coverage, explicitness, consistency, and optional prompt-variance measurements. Confidence is `low`, `medium`, or `high`.

## Bias implementation

The internal taxonomy supports the Media Bias Elements vocabulary. The first POC implements a focused subset with stable definitions:

- word choice
- speculation
- unsubstantiated claims
- cherry picking
- source selection
- whataboutism
- false balance
- false dichotomy
- flawed comparison
- generalization
- ad hominem
- emotional sensationalism
- straw man

The provider may return multiple candidates. Validation confirms excerpts and the final selector ranks:

```text
impact = confidence * article relevance * prominence
```

The three highest meaningful findings are rendered with a short name, explanation, and excerpt.

## Research implementation

### Research claims

The Article Lens returns at most six factual claims worth researching. Each claim has a stable ID, text, paragraph IDs, importance, and research query hints.

### Tool budget

- maximum six search calls
- maximum twelve fetched documents
- maximum eight AI/tool steps
- maximum three Supporting sources
- maximum three Contradicting sources
- maximum two Additional Context sources
- maximum three Journalist Context findings

### Source ranking

1. Primary record or original dataset
2. Direct institutional or expert source
3. Strong independent reporting
4. Relevant analysis or commentary

Results are ranked by claim relevance, source directness, excerpt support, publication date relevance, and duplication. Political perspective diversity broadens discovery while evidentiary strength controls final ranking.

## Streaming protocol

The API uses one POST request and returns newline-delimited typed events or an AI SDK UI message stream. The transport adapter must preserve these domain events:

1. `analysis.started`
2. `metadata.ready`
3. `sourceList.ready`
4. `compass.ready`
5. `bias.ready`
6. `journalistContext.ready`
7. `supporting.ready`
8. `contradicting.ready`
9. `additionalContext.ready`
10. `analysis.completed`

`section.failed` can occur at any point after `analysis.started`. A failure contains a safe message and retryable flag. The pipeline continues when sections are independent.

## Extension implementation

### Entrypoints

- `entrypoints/background.ts`
  - opens the side panel from the toolbar action
  - maintains the active analysis state
- `entrypoints/content.ts`
  - responds to extraction requests
  - runs DOM extraction in the page
- `entrypoints/sidepanel/`
  - React application
  - active tab discovery
  - extraction request
  - API streaming client
  - report state reducer
  - text-first section components

### UI states

- checking ChatGPT session
- requesting user consent
- waiting for device authorization
- idle
- extracting
- analyzing
- partially ready
- completed
- article unsupported
- section failure
- request failure

All headings are visible after a request starts. The Political Spectrum disclosure button shows label and confidence when ready. Opening it pushes the following content downward. Other sections render as text with dividers and quiet loading states.

## Backend implementation

### Route

`POST /api/analyze`

1. Validate request size and schema.
2. Resolve the authenticated ChatGPT session in live mode.
3. Fetch the connected account's available model list and select the configured or first
   available model.
4. Compute or accept the article fingerprint.
5. Return a cached final report when the fingerprint and analysis version match.
6. Start a typed stream.
7. Emit deterministic metadata and Works Cited.
8. Run the Article Lens through the request-bound ChatGPT proxy.
9. Validate and emit Compass and Bias.
10. Run bounded research.
11. Validate and emit research sections.
12. Store the final report and metrics.
13. Emit completion.

The request abort signal is passed through the pipeline and provider calls.

### Providers

- `DemoArticleLensProvider`
- `AiSdkArticleLensProvider`
- `DemoResearchProvider`
- `WebSearchResearchProvider`

ChatGPT mode is the POC default. `PERSPECTICA_MODE=demo` is an explicit, deterministic
fallback for tests and offline development. Live mode never silently falls back to demo
analysis after an authentication or provider failure.

## Storage

Tables:

- `key_value_entries`
  - signed session ID key
  - encrypted login-session envelope
  - expiration timestamp
- `articles`
  - fingerprint
  - canonical URL
  - normalized metadata
- `analyses`
  - ID
  - article fingerprint
  - status
  - report JSON
  - prompt version
  - model version
  - pipeline version
  - timings and token metrics
- `evaluation_runs`
  - fixture
  - configuration
  - expected labels
  - actual labels
  - stability and quality metrics

The persistent key/value implementation is active for ChatGPT sessions. Analysis report
repositories remain part of Phase 4.

## Verification plan

### Unit tests

- shared schema acceptance and rejection
- URL and article normalization
- exact and normalized excerpt matching
- compass calculation for every quadrant
- center and unclear labeling
- confidence calculation
- bias limit and ranking
- source separation and deduplication
- stream reducer state transitions

### Integration tests

- demo pipeline event order
- one failed research section does not erase Compass or Bias
- cached report round trip
- aborted request cancels the pipeline
- API accepts a valid article and rejects malformed or oversized input

### Extension tests

- content extraction against synthetic article fixtures
- side-panel initial state and heading order
- disclosure button expands and collapses
- incoming events populate the correct section
- empty Journalist Context state
- source links retain their correct provenance

### Manual acceptance

1. Run the API and extension in demo mode.
2. Load the unpacked Chrome build.
3. Open a synthetic local article.
4. Open Perspectica from the toolbar.
5. Confirm extraction, streaming order, scroll layout, compass expansion, links, and retry behavior.

## Delivery phases

### Phase 0 - Foundation

- workspace configuration
- linting, formatting, type checking, and tests
- environment example and developer README
- shared contracts

Exit: all packages compile and a minimal test runs.

### Phase 1 - Deterministic vertical slice

- article extraction
- demo Article Lens and Research providers
- compass scoring and validation
- typed streaming API
- complete side-panel report UI

Exit: the full experience works locally without external credentials.

### Phase 2 - Live Article Lens

- encrypted Login with ChatGPT session boundary
- dynamic account-model discovery
- AI SDK structured-output provider
- prompt templates
- article evidence validation
- prompt/model versioning
- prompt-variant evaluation harness

Exit: Compass and Bias use live model output with deterministic validation, and the prompt
variant harness measures stability.

### Phase 3 - Bounded research

- search provider adapter
- claim-centered research tools
- journalist-context rules
- source retrieval and excerpt validation
- research cost and latency metrics

Exit: live supporting, contradicting, contextual, and journalist findings render with provenance.

### Phase 4 - Storage and repeatability

- Drizzle SQLite migrations
- report cache
- evaluation run storage
- analysis history for developers

Exit: identical article and version combinations reuse stored results.

### Phase 5 - POC evaluation and polish

- expert-reviewed fixture set
- prompt robustness tests
- accessibility audit
- responsive side-panel polish
- failure and retry flows
- demo script and packaging

Exit: the team can demonstrate and evaluate the POC consistently.

## Implemented build slices

The first slice completed the monorepo, contracts, extraction, deterministic validation,
streaming pipeline, demo providers, and complete side-panel report.

The second slice added:

1. A stable extension identity and exact-origin credentialed CORS.
2. In-extension consent, ChatGPT device login, session hydration, and logout.
3. Encrypted, TTL-aware SQLite session persistence through Drizzle ORM.
4. A rate-limited request-bound ChatGPT Responses proxy with raw token export disabled.
5. Dynamic connected-account model discovery.
6. The AI SDK 7 structured-output Article Lens.
7. Live-mode composition with an explicit deterministic demo fallback.

Bounded external research, analysis caching, and the prompt-variant evaluation harness are
the next implementation targets.

## Risks and recovery

- **News DOM variability:** use layered extraction heuristics and fixture-driven tests.
- **Prompt instability:** version prompts, run paraphrase variants, and make article-local claims.
- **Quoted-position leakage:** track speakers and endorsement before compass scoring.
- **Unsupported excerpts:** require deterministic paragraph matching.
- **Research cost:** enforce hard search, fetch, and step budgets.
- **False source relationships:** require claim IDs, source excerpts, and validation.
- **Extension/API drift:** generate types from the shared Zod contracts.
- **Partial stream failure:** keep section states independent and persist successful results.
- **Provider dependency:** keep demo mode as the reliable local development baseline.
- **Experimental login dependency:** isolate the community handler behind the API
  composition root and keep a replaceable provider boundary.
- **Plan usage exhaustion:** show consent, select from the account's available models, limit
  proxy request size, and rate-limit analysis calls per session.
- **Credential leakage:** use HttpOnly cookies, encrypted server storage, exact-origin CORS,
  and a proxy that never exports raw tokens.
