# Perspectica

Perspectica is a Chrome side-panel proof of concept for source-grounded news transparency.

It analyzes an article's political framing, bias signals, journalist context, supporting and
contradicting information, and cited sources. It helps readers inspect an article; it does not
replace reading it or make fixed judgments about a publication or person.

## Public repository notes

- The source code is released under the [MIT License](LICENSE).
- Local environment files, database/session data, generated assets, and raw calibration corpora
  are intentionally ignored. The corpus may contain third-party article text and is rebuilt
  locally rather than published.
- Read [public deployment guidance](docs/public-deployment.md) and the
  [security policy](SECURITY.md) before hosting or redistributing a build.

The implementation plan is available at:

- `docs/plans/2026-07-28-perspectica-build-plan.md`

The adopted agentic research design is available at:

- `docs/plans/2026-07-29-agentic-research-and-reader-copy-design.md`

The adopted seven-position spectrum design and calibration dataset are available at:

- `docs/plans/2026-07-29-seven-position-spectrum-design.md`
- `datasets/political-spectrum/README.md`

## Prerequisites

- Node.js 22 or newer
- pnpm 9
- Chrome or another Chromium browser with the Side Panel API

## Install

```bash
pnpm install
```

Create your local API configuration:

```bash
cp apps/api/.env.local.example apps/api/.env.local
```

## Develop

Run the API. ChatGPT mode is the default:

```bash
pnpm dev:api
```

Live research needs a server-only Exa key in `apps/api/.env.local`:

```dotenv
EXA_API_KEY=your_exa_api_key
```

Run the extension in a second terminal:

```bash
pnpm dev:extension
```

The WXT development command opens a Chromium profile with the extension installed. Open
a news article and select the Perspectica toolbar action. On first use, the side panel asks
you to connect ChatGPT before it analyzes the active tab.

### ChatGPT connection

Perspectica uses the experimental
[`opencoredev/login-with-chatgpt`](https://github.com/opencoredev/login-with-chatgpt)
device flow for this proof of concept:

1. Select **Connect ChatGPT** in the side panel.
2. Complete sign-in on the OpenAI page using the displayed one-time code.
3. Return to the side panel; Perspectica detects the authenticated session and begins the
   analysis.

Your OpenAI password is never entered into or stored by Perspectica. The local API receives
refreshable session tokens after authorization, encrypts them before writing them to SQLite,
and gives the extension only an HttpOnly session cookie. Raw token export is disabled. The
local encryption key is created at `apps/api/data/perspectica-session.key` with owner-only
permissions and survives API restarts.

Live analyses use the connected account's ChatGPT/Codex plan usage. Perspectica discovers
the account's model catalog and also manually exposes `gpt-5.6-luna`, because newly released
Codex models can be accepted by the responses endpoint before they appear in `/models`.
The upstream endpoint remains authoritative: an account without access receives a clear
model error. The side panel includes an explicit disconnect action that deletes the saved
server session.

This integration is a community POC mechanism, not OpenAI's public Sign in with ChatGPT
identity product. Use it only with informed consent and review the
[OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) before broader distribution.

### Deterministic demo mode

The key-free demo remains available for development and automated tests. Start both apps
with demo mode enabled:

```bash
PERSPECTICA_MODE=demo pnpm dev:api
WXT_PERSPECTICA_MODE=demo pnpm dev:extension
```

## Build and load in Chrome

```bash
pnpm build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select:

```text
apps/extension/.output/chrome-mv3
```

Keep the API running at `http://localhost:3000` while using this build. The committed
manifest public key gives local builds the stable extension ID
`daefmnkkogfkfmmikoomfmkdkfknilff`, which is the only extension origin accepted by the
local API.

For a hosted API, build the extension with the API origin exported so the host permission is
embedded in the manifest:

```bash
WXT_API_BASE_URL=https://api.example.com pnpm --filter @perspectica/extension build
```

See [the deployment guide](docs/public-deployment.md) for the required HTTPS, secret, storage,
and exact-origin configuration.

## Current implementation

The current vertical slice includes:

- browser article extraction and original link collection
- typed newline-delimited streaming
- in-extension ChatGPT consent, device login, session state, and disconnect
- encrypted SQLite session persistence with exact-origin CORS and proxy rate limiting
- dynamic discovery plus manual GPT-5.6 Luna model exposure
- an AI SDK 7 Article Reader that produces grounded spectrum evidence, bias candidates, and one
  shared article dossier
- six bounded AI SDK tool-loop specialists for political context, bias, journalist context,
  supporting information, contradicting information, and additional context
- three agent-chosen Exa Fast searches in parallel for every applicable specialist, with one
  optional focused Fast or Deep escalation
- Exa Contents source reading, canonical URL deduplication, exact-excerpt validation, shared
  caching, and per-section failure isolation
- validated deterministic seven-position political-spectrum placement with article-led, context-assisted, and
  low-confidence context-led bases
- a source-backed 100-article calibration dataset spanning 10 publications
- validated live or demo bias findings
- compact reader-facing copy with inline citations and hidden empty research sections
- independent progressive loading and failure state for each report section

## Optional configuration

The defaults work for the local POC. See `apps/api/.env.local.example` for server configuration
and `apps/extension/.env.example` for extension-build configuration. The root `.env.example` is
a combined reference only.
The most useful overrides are:

- `PERSPECTICA_SESSION_SECRET`: a deployment-provided secret for cookie signing and
  encryption.
- `PERSPECTICA_CODEX_CLIENT_VERSION`: the model-catalog client version sent to Codex.
- `PERSPECTICA_MANUAL_CHATGPT_MODELS`: comma-separated model IDs merged into discovery.
- `PERSPECTICA_CHATGPT_MODEL`: the exact model selected for analysis.
- `PERSPECTICA_CHATGPT_REASONING_EFFORT`: `none`, `low`, `medium`, `high`, or
  `xhigh`; defaults to `medium`.
- `PERSPECTICA_ALLOWED_CHATGPT_MODELS`: a comma-separated responses-proxy allowlist.
- `PERSPECTICA_DB_PATH`: the SQLite session database location.
- `EXA_API_KEY`: the server-only credential for external research retrieval.
- `WXT_API_BASE_URL`: the API origin compiled into the extension.

## Verify

```bash
pnpm verify
```
