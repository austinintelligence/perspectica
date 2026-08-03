# Perspectica

Perspectica is a self-contained Chrome side-panel extension for source-grounded news
transparency. It examines political framing, bias signals, journalist context, supporting and
contradicting information, and the sources cited by an article.

Perspectica helps readers inspect an article. It does not replace reading the article, determine
whether a person is trustworthy, or assign a permanent political label to a publication.

## About us

Perspectica was created by:

- **Austin Morgan** — Developer & AI orchestration
- **Lathik Ram C.** — Concept lead, UI design & outreach
- **Mathew Estis** — Developer & project coordination
- **Jordan Allen** — Brand design & QA testing

The same team credits are available from the extension's first-run **About us** panel.

## How it works

Everything runs inside the installed extension:

1. The user opens Perspectica and chooses **Login with ChatGPT**. Chrome requests only the narrow
   OpenAI origins needed for the device flow and inference.
2. During article-access onboarding, the user separately grants a remembered all-sites permission
   so Perspectica can extract the active page when a report starts or is reopened.
3. An offscreen extension document runs the analysis pipeline so MV3 service-worker suspension
   does not interrupt longer work.
4. The extension uses the user's connected ChatGPT account for inference.
5. Research uses either the user's Exa API key or ChatGPT hosted web search when the selected
   account and model support it.
6. Validated pipeline events are appended to an IndexedDB journal and streamed into the side panel through a reconnectable runtime port.

There is no Perspectica API, hosted database, localhost service, telemetry service, or required
Codex installation.

## Privacy model

- OpenAI credentials are entered only on OpenAI's authorization page.
- Chrome asks for narrow OpenAI access from the login action, then separately asks during
  onboarding for access to standard websites. It remembers each choice, and no persistent content
  script is installed.
- **Remember me on this device** is enabled by default. The refresh token is encrypted with
  AES-256-GCM and stored in the current Chrome profile.
- The non-exportable encryption key is stored separately in IndexedDB.
- Access tokens are kept in `chrome.storage.session` and refreshed when needed.
- Exa API keys are encrypted by the same local vault.
- Article text and research queries are sent only to the providers the user selects.
- Perspectica does not operate a server that receives credentials, article text, or analysis
  history.

Deleting the Chrome profile, clearing extension data, or uninstalling the extension removes the
local vault. Disconnecting ChatGPT removes the remembered session immediately.

The ChatGPT connection uses the experimental community
[`opencoredev/login-with-chatgpt`](https://github.com/opencoredev/login-with-chatgpt) device
flow. It is not OpenAI's public identity product. Review the provider's terms before distributing
or using the extension broadly.

## Project structure

```text
apps/extension/        WXT Manifest V3 extension, side panel, background and offscreen runtime
packages/contracts/    shared Zod wire contracts, budgets, events and evidence graph types
packages/extraction/   page-to-article extraction and deterministic ArticleIndex construction
packages/intelligence/ Article Lens, adaptive planning, retrieval coordination and report projection
docs/                   current architecture, privacy, release and product notes
```

The implemented V2 runtime is documented in [`docs/architecture-v2.md`](docs/architecture-v2.md).
Older planning notes under `docs/plans/` are historical and are not production architecture.

## Prerequisites

- Node.js 22 or newer
- pnpm 9.15.4 or newer
- Chrome or another Chromium browser with the Side Panel and Offscreen APIs

## Develop

```bash
pnpm install
pnpm dev
```

For live development, load this directory once from `chrome://extensions`:

```text
apps/extension/.output/chrome-mv3-dev
```

Keep `pnpm dev` running whenever that developer extension is enabled. WXT watches the source tree,
serves its development modules on `localhost:3001`, and reloads supported extension contexts in
the existing Chrome profile. Stopping the command also stops the modules used by the development
build.

The self-contained production directory is deliberately separate:

```text
apps/extension/.output/chrome-mv3
```

It is refreshed by `pnpm build`, works without a local server, and is the right directory for
stable manual testing. Reload its extension card in `chrome://extensions` after rebuilding. The
release ZIP is only for Chrome Web Store upload and does not need to be unpacked during
development.

No environment file is required for the extension. Exa keys are entered in onboarding and saved
only in that Chrome profile.

## Build and load unpacked

```bash
pnpm build
```

Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose:

```text
apps/extension/.output/chrome-mv3
```

Every `pnpm build` and `pnpm package:extension` refreshes this same unpacked directory before
creating release artifacts.

To create the Chrome Web Store ZIP:

```bash
pnpm package:extension
```

See [`docs/public-deployment.md`](docs/public-deployment.md) for the store checklist and
[`docs/privacy.md`](docs/privacy.md) for the reader-facing privacy disclosure.

## Analysis architecture

V2 builds one compact `ArticleIndex`, creates an adaptive `AnalysisPlan`, and runs a global
`RetrievalCoordinator` against a shared source ledger and evidence graph. Fast, balanced, and deep
modes change passage, mission, concurrency, deadline, and output budgets. Evidence is validated
once before it can serve any report section, and sections only project the ledger; the side panel
never reconciles sources itself.

Exa uses bounded search requests with returned text/highlights. Native ChatGPT web search is one
bounded global search workflow: its URL-attributed results are `search-summary` evidence and are
never treated as page transcripts or quoteable excerpts. Login with ChatGPT remains the sole
account/authentication path; Exa is an optional research provider key, not a second account system.

## Optional calibration tooling

The political-spectrum calibration scripts are development tools, not extension runtime
dependencies. To rebuild local research data, place an Exa key in an ignored root `.env.local`:

```dotenv
EXA_API_KEY=your_key
```

Then use the `dataset:spectrum:*` scripts documented in
[`datasets/political-spectrum/README.md`](datasets/political-spectrum/README.md). Raw article
corpora remain untracked because they may contain third-party text.

## Verify

```bash
pnpm verify
pnpm verify:release
pnpm audit --prod --audit-level=high
```

## License

Perspectica is released under the [MIT License](LICENSE).
