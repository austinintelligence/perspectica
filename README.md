# Perspectica

## Install Perspectica

### Chrome Web Store (recommended)

The Chrome Web Store is the consumer installation and automatic-update channel. Open the official
listing, confirm the publisher and permissions, and choose **Add to Chrome**. Chrome, Edge, and
Brave are supported on macOS and Windows; the release checklist remains policy-conditional until
the public listing has passed review.

### GitHub developer release

Tagged [GitHub Releases](https://github.com/drperky20/perspectica/releases) include the self-contained extension ZIP, checksums, an
SBOM, provenance, and small macOS/Windows setup helpers. The helper verifies the ZIP, installs it
to a stable local directory, detects supported browsers, opens the selected browser's extensions
page, and reveals the directory to choose with **Load unpacked**. Browser security still requires
that one visible Developer Mode action; the helper never changes browser policy or silently
installs code.

See [browser support](docs/browser-support.md), [release installation](tools/installer/README.md),
and [troubleshooting](docs/troubleshooting.md) before using the developer channel.

Perspectica is a self-contained Chrome side-panel extension for source-grounded news
transparency. It examines political framing, bias signals, journalist context, supporting and
contradicting information, and the sources cited by an article.

Perspectica helps readers inspect an article. It does not replace reading the article, determine
whether a person is trustworthy, or assign a permanent political label to a publication.

## Built by

Perspectica was created by:

- **Austin Morgan** — Developer & AI orchestration
- **Lathik Ram C.** — Concept lead, UI design & outreach
- **Mathew Estis** — Developer & project coordination
- **Jordan Allen** — Brand design & QA testing

The same team credits are available from the extension's first-run **About us** section and
Settings → **About** screen.

## How it works

Everything runs inside the installed extension:

1. Open a news article and review the local article preview. Nothing is sent to a provider yet.
2. Choose Quick, Balanced, Deep, or Verified research and select **Analyze article**.
3. Article Lens identifies claims and framing, then one bounded research coordinator builds a
   deduplicated source pool for the whole report.
4. Perspective and evidence evaluators use the same source ledger in parallel. Deterministic
   validation removes unsupported quotations, unsafe URLs, duplicate claims, and wrong-lane
   evidence before sections appear.
5. A reconnectable event journal streams each section to the side panel and supports cancellation,
   resume, and targeted section retries without restarting completed work.

Research can use the keyless Free lane, authenticated ChatGPT discovery, or a user-supplied Exa
key. Search summaries are never quoted as source text; a quotation requires a fetched publisher
page and exact-excerpt validation.

There is no Perspectica API, hosted database, localhost service, telemetry service, hosting bill,
or required Codex installation.

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
- Article text and research queries are sent only after Analyze and only to the configured
  inference/research providers and validated public source pages needed for the requested report.
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
tools/installer/        audited GitHub developer-channel setup helper
docs/                   architecture, privacy, security, release and support notes
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
`RetrievalCoordinator` against a shared source ledger and evidence graph. Quick, Balanced, Deep,
and Verified depths change passage, mission, concurrency, source, model-call, and time budgets.
Providers return
candidate sources only; a bounded adjudication step maps exact candidate IDs to article claims and
relationships, and centralized validation is required before an assertion can serve any report
section. The side panel only projects validated ledger assertions.

The one-dimensional spectrum stays on `-3…+3`. Article framing supplies exactly half of the
placement evidence, while verified publication and journalist context share the remaining half.
Outside reporting may refine context but cannot manufacture an article position. “Unclear” is
reserved for runs where the article and all contextual research provide no defensible signal.

See [V2 architecture](docs/architecture-v2.md), [provider boundaries](docs/provider-boundaries.md),
[privacy](docs/privacy.md), and the [threat model](docs/threat-model.md).

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
