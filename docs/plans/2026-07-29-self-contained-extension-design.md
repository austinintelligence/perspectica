# Perspectica Self-Contained Extension Design

**Status:** Approved for implementation  
**Date:** July 29, 2026  
**Target:** Chrome Manifest V3 extension with no Perspectica-hosted backend

## Objective

Ship Perspectica as a fully self-contained Chrome extension. The extension
extracts the active article, authenticates directly with the user's ChatGPT
account, performs the analysis locally in extension-owned browser contexts,
uses the user's selected search provider, and renders progressive results in
the side panel.

The installed extension must:

- require no local API server, Codex installation, or Perspectica hosting;
- remember the user's ChatGPT connection on the current Chrome profile;
- let the user choose Exa or compatible native ChatGPT search;
- keep credentials out of page and content-script contexts;
- survive browser and computer restarts and ordinary extension updates;
- preserve the current progressive Perspectica report experience;
- be packageable for the Chrome Web Store.

## Product Contract

### First-run onboarding

1. Explain that analysis uses the user's ChatGPT plan and sends the selected
   article text to ChatGPT.
2. Ask the user to connect ChatGPT through the device authorization flow.
3. Offer **Remember me on this device**, enabled by default.
4. Ask the user to select a search provider:
   - **Exa:** requires the user's Exa API key.
   - **ChatGPT search:** available only when the connected account and direct
     Codex transport support the hosted search tool.
5. Discover available models from the connected account and let the user choose
   a model and reasoning effort.
6. Run a small connection and provider capability check.
7. Save preferences locally and open the article report.

### Remembered connection

When **Remember me on this device** is enabled, Perspectica stores only the
minimum durable credential data needed to refresh the user's ChatGPT session.
The refresh token is encrypted before it is written to extension storage.
Access tokens remain temporary.

The remembered connection survives:

- browser restarts;
- computer restarts;
- ordinary extension updates.

The connection is intentionally removed by:

- **Disconnect and forget this device**;
- uninstalling the extension;
- clearing extension/site data;
- token revocation or account-policy invalidation.

### Article access

Perspectica analyzes only the active tab after the user explicitly opens or
invokes the extension. It does not run a permanent content script on every
page. The extension requests temporary access with `activeTab`, injects the
packaged extractor, and immediately returns a bounded article payload.

## Runtime Architecture

```text
Active article tab
    |
    | activeTab + scripting, on demand
    v
Packaged extractor
    |
    | bounded ArticleInput message
    v
MV3 background service worker
    | \
    |  \ encrypted credential vault + preferences
    |   \ chrome.storage + IndexedDB
    |
    | create/reconnect job
    v
Offscreen analysis document
    |
    | creates dedicated analysis Worker
    v
Browser analysis pipeline
    | \
    |  \ direct ChatGPT Codex transport
    |   \ Exa REST or compatible ChatGPT web search
    |
    v
Progressive AnalysisEvent stream
    |
    v
Side-panel report
```

### Background service worker

The background service worker is the trusted control plane. It:

- validates every runtime message and sender;
- owns the credential vault and token-refresh operation;
- creates the offscreen document when analysis is requested;
- assigns job IDs and persists minimal resumable job state;
- forwards progressive events to connected side panels;
- reconnects the UI to an active or completed job;
- never performs long model generations itself.

This design does not depend on service-worker longevity. Every operation can be
reconstructed from persisted job metadata and the offscreen runtime.

### Offscreen document and Worker

The extension creates one packaged offscreen document using the `WORKERS`
reason. The document starts a dedicated Worker that runs the analysis pipeline.
Long-lived model and search fetches therefore do not depend on the MV3
background worker's inactivity lifetime.

The analysis Worker receives:

- a bounded, validated article dossier;
- provider preferences;
- a short-lived access token;
- a job budget and abort signal.

It never receives the durable refresh-token envelope or encryption key.
If its access token expires, it asks the background control plane for a new
short-lived token.

### Side panel

The side panel is a presentation and interaction surface. It:

- requests extraction and analysis;
- subscribes to a job through a runtime port;
- renders progressive section events;
- restores completed or partial job state after reopening;
- provides onboarding and settings;
- never reads raw credentials.

## Typed Message Protocol

All extension messages use discriminated unions with schema validation.

Primary commands:

- `runtime.getState`
- `auth.beginDeviceFlow`
- `auth.pollDeviceFlow`
- `auth.disconnect`
- `auth.listModels`
- `auth.getAccessToken` (trusted runtime contexts only)
- `providers.test`
- `preferences.get`
- `preferences.update`
- `analysis.start`
- `analysis.cancel`
- `analysis.getJob`
- `analysis.subscribe`

Primary events:

- `auth.deviceCodeReady`
- `auth.connected`
- `auth.expired`
- `analysis.status`
- `analysis.event`
- `analysis.completed`
- `analysis.failed`

Every request carries a generated request ID. Every analysis event carries an
analysis/job ID and monotonically increasing sequence number so reconnecting
clients can safely ignore duplicates.

## Credential Vault

### Storage layout

The vault uses two separate stores:

- IndexedDB: a non-exportable AES-256-GCM `CryptoKey`;
- `chrome.storage.local`: versioned encrypted credential envelopes and
  non-sensitive account/provider metadata.

Temporary access tokens use memory and `chrome.storage.session`. Extension
storage access levels are restricted to trusted extension contexts.

### Encryption

For every durable write:

1. Generate a new 96-bit random IV.
2. Serialize only the required credential fields.
3. Encrypt with AES-256-GCM.
4. Bind additional authenticated data to:
   - vault schema version;
   - extension runtime ID;
   - credential purpose.
5. Store the IV, ciphertext, schema version, and creation time.

If the IndexedDB key is missing while an encrypted envelope exists, the vault
fails closed and asks the user to reconnect. It never silently regenerates a key
and pretends the prior credential is recoverable.

The same vault may store a user-provided Exa key under a different authenticated
purpose. ChatGPT and Exa secrets are separately encrypted.

### Threat boundary

This protects credentials against casual storage inspection and accidental
plaintext leakage. It cannot protect against a malicious extension update,
malware or browser-profile compromise, operating-system compromise, or an
attacker already executing inside a trusted extension context. Onboarding and
the privacy policy disclose this experimental direct-account design clearly.

## ChatGPT Authorization and Model Access

Perspectica uses the low-level `@opencoredev/loginwithchatgpt-core` device flow
and Codex transport directly from trusted extension contexts.

Authorization flow:

1. Request a device code and PKCE material.
2. Show the verification URL/code and open the authorization page.
3. Poll the device endpoint until the user authorizes or the code expires.
4. Exchange the authorization result for account tokens.
5. Persist the refresh token only when **Remember me** is enabled.
6. Discover the account's actual Codex model list.
7. Store the selected supported model ID as a preference.

Model IDs are never treated as universally available. Perspectica may surface
known models such as GPT-5.6 Luna only when discovery or a capability probe
confirms the connected account can use them.

The direct transport must:

- refresh credentials before expiry;
- redact tokens from errors and logs;
- set bounded response, reasoning, and tool budgets;
- stream structured output;
- surface revocation as an actionable reconnect state.

## Search Providers

### Exa

The Exa provider calls the HTTPS API directly from the analysis Worker using the
user's encrypted local API key. It supports:

- multiple complementary searches per article;
- domain/date/category constraints;
- result deduplication by canonical URL;
- bounded text retrieval;
- source-quality and relevance ranking.

### Native ChatGPT search

Native search is capability-gated. During onboarding Perspectica runs a small
structured tool-call probe through the direct Codex transport. If the account or
transport does not support hosted `web_search`, the option is disabled with a
plain explanation and Exa remains available.

The analysis pipeline consumes a common `SearchProvider` interface, so native
search can be enabled without changing prompts or report schemas.

## Analysis Orchestration

The existing specialist architecture performs repeated searches and too many
model calls. The self-contained pipeline uses shared context and three bounded
model phases.

### Phase 1: Article lens

One model call reads the article once and produces a structured dossier:

- article type and central claims;
- entities, events, dates, and disputed facts;
- framing and bias candidates grounded in article passages;
- provisional political placement;
- research questions for publication, journalist, and claim verification.

The provisional political placement and bias section can stream to the UI
immediately.

### Shared research

The pipeline derives roughly six complementary searches from the dossier and
runs them concurrently:

- central-claim verification;
- material contradiction or qualification;
- primary/official record;
- publication historical framing;
- journalist relevant public work;
- missing explanatory context.

Results enter one job-scoped source pool. The pool:

- canonicalizes and deduplicates URLs;
- preserves title, publisher, date, query, and retrieved passage;
- rejects unusable or weakly relevant sources;
- ranks sources against dossier claims;
- exposes compact evidence packets to later phases.

No specialist independently repeats searches already present in the pool.
Target latency is approximately 30 seconds, but the normal job timeout is longer
and represents a safety ceiling, not the desired response time.

### Phase 2: Perspective synthesis

One model call combines the article dossier with relevant publication and
journalist evidence to produce:

- final seven-position political spectrum placement;
- concise publication/journalist context;
- refined bias findings where comparative evidence matters.

The article remains the largest single evidence component. Publication history,
journalist work, and comparable coverage can influence the placement and other
sections, but cannot override direct article evidence without an explicit,
grounded reason.

### Phase 3: Evidence synthesis

One model call maps the shared source pool into:

- supporting information;
- contradicting or materially qualifying information;
- additional context.

It prefers primary sources and independent corroboration, avoids repeating the
same fact across sections, and returns explicit empty states when no responsible
finding exists.

### Progressive and partial completion

The pipeline emits validated events after every phase. A failure in one phase
does not discard completed sections. The UI identifies a partial result and
offers a targeted retry for failed work.

## Error Handling and Recovery

- Device code expiration: restart authorization without losing preferences.
- Refresh revocation: clear temporary tokens, preserve non-secret preferences,
  and request reconnection.
- Missing vault key: fail closed and offer **Forget stored connection**.
- Provider rate limit: show provider-specific retry timing.
- Search failure: continue with article-only analysis where responsible and mark
  research-dependent sections partial.
- Model/schema failure: perform one bounded structured-output repair attempt.
- Service-worker restart: reconstruct jobs from persisted metadata and reconnect
  to the offscreen runtime.
- Offscreen/Worker loss: mark the in-flight phase interrupted and allow a clean
  retry from the latest persisted checkpoint.
- Tab navigation: reject stale extraction results whose tab URL no longer
  matches the requested analysis.

All errors shown to users are short and actionable. Logs contain request IDs,
phase timings, and status, never credentials or full article text.

## Manifest and Privacy

Target permissions:

- `activeTab`
- `scripting`
- `storage`
- `offscreen`
- `sidePanel`

Target host permissions are restricted to the exact ChatGPT authorization/Codex
and Exa HTTPS origins required by the selected providers. Perspectica removes
the permanent all-site content script, localhost permissions, cookies, server
CORS, and hardcoded development extension key from store builds.

The Web Store privacy disclosure states:

- article text is sent to the user's selected AI/search providers;
- authentication and provider credentials are stored locally;
- no article or account data is sent to Perspectica-operated servers;
- the user can disconnect and erase local provider credentials at any time.

## Repository Migration

Target organization:

```text
apps/extension/
  entrypoints/
    background.ts
    offscreen/
    sidepanel/
  src/
    auth/
    jobs/
    messaging/
    onboarding/
    providers/
    report/
    runtime/
    storage/

packages/
  analysis/
    pipeline/
    dossier/
    prompts/
    research/
    events/
  contracts/
  extraction/
  providers/
    chatgpt/
    exa/
    native-search/
  validation/
  compass/
```

Migration order:

1. Add typed messaging, vault, and provider interfaces.
2. Add direct ChatGPT and search capability tests.
3. Add offscreen Worker and job controller.
4. Refactor the analysis pipeline to the shared three-phase design.
5. Connect the side panel to runtime messaging.
6. Replace onboarding/settings.
7. Convert extraction to explicit on-demand injection.
8. Remove `apps/api`, `packages/storage`, localhost configuration, and
   server-only dependencies.
9. Update documentation, privacy disclosures, and packaging.

The public workspace ends with one installable extension runtime. There is no
legacy server path in the shipped package.

## Validation

### Unit and contract tests

- message schema validation and sender checks;
- vault encrypt/decrypt, random IVs, AAD mismatch, missing-key failure;
- refresh-token lifecycle and redaction;
- provider capability detection and fallback;
- URL canonicalization, source deduplication, and evidence ranking;
- pipeline checkpoints, partial failures, retries, and duplicate events;
- on-demand extraction bounds and stale-tab rejection;
- prompt fixtures and structured-output schemas.

### Integration tests

- device flow with mocked endpoints;
- remembered session restoration after runtime restart;
- Exa and native-search adapter behavior;
- complete analysis job across background, offscreen document, Worker, and side
  panel;
- reconnecting a side panel to an active/completed job;
- disconnect erases the key, envelopes, session token, and provider secrets.

### Manual Chrome checks

- load the unpacked production build;
- complete onboarding and reconnect after restarting Chrome;
- analyze supported articles from multiple publishers;
- verify no analysis runs before explicit user action;
- inspect extension storage for absence of plaintext secrets;
- switch providers/models and run connection checks;
- revoke/disconnect and verify recovery;
- inspect animations, scrolling, streaming, and partial-state UX;
- review requested permissions and all outbound origins.

### Release gates

- formatting, typecheck, unit/integration tests, and production build pass;
- no known high-severity production vulnerabilities;
- final manifest contains only approved permissions and hosts;
- no localhost URLs, server cookies, SQLite, or server-only packages remain;
- generated Chrome Web Store ZIP installs and completes a real analysis;
- README, architecture, security, privacy, and Web Store instructions match the
  shipped behavior.
