# Perspectica

Understand the story behind a story.

Perspectica is a Chrome side panel that helps you examine an article's framing, evidence, author and publication context, supporting information, contradicting information, and cited sources before you decide what to believe or share.

It is built for readers who want more context without opening ten tabs—and for developers interested in building careful, source-grounded AI experiences inside the browser.

## What a reader gets

When you start an analysis, Perspectica can help you inspect:

- the article's main claims and framing signals;
- relevant context about the publication and byline;
- supporting and contradicting information from selected research providers;
- the sources behind each report section;
- the difference between an article's own text and outside research.

Perspectica is not a truth oracle. It does not replace reading the article, decide whether a person is trustworthy, or assign a permanent political label to a publication. Its job is to make the reasoning and sources easier to inspect.

## How it works

Everything runs inside the installed extension:

1. Open Perspectica from Chrome's side panel and choose **Login with ChatGPT**.
2. During onboarding, separately allow article access when you want to analyze the active page.
3. Perspectica extracts the active article only when an analysis starts or a saved report is reopened.
4. The extension builds a structured article index and an analysis plan.
5. The selected AI and search providers research the claims within bounded budgets.
6. Validated evidence is written to a local journal and projected into the side panel.

There is no Perspectica API, hosted database, localhost service, telemetry backend, or required Codex installation.

### Authentication note

Login with ChatGPT is the only account path. The connection uses the community [`opencoredev/login-with-chatgpt`](https://github.com/opencoredev/login-with-chatgpt) device-flow library; it is not OpenAI's public identity product. Review that provider's terms before distributing the extension broadly.

Exa is an optional research provider. When supported by the connected account and selected model, ChatGPT web search can be used instead. Neither provider creates a second Perspectica account system.

## Privacy at a glance

- Perspectica does not operate a server that receives your credentials, article text, or analysis history.
- OpenAI credentials are entered only on OpenAI's authorization page.
- Article access is granted separately in Chrome and is not implemented as a permanent content script that reads every page.
- Remembered ChatGPT and Exa credentials are encrypted and kept in the current Chrome profile.
- Article text and research queries are sent only to the providers you choose for the requested analysis.

Read the full [privacy notice](docs/privacy.md) before using a development build with personal browsing data.

## Try the extension locally

Prerequisites:

- Node.js 22 or newer;
- pnpm 9.15.4 or newer;
- Chrome or another Chromium browser with Side Panel and Offscreen APIs.

```bash
pnpm install
pnpm dev
```

For live development, load `apps/extension/.output/chrome-mv3-dev` from `chrome://extensions` while `pnpm dev` is running. For a self-contained build:

```bash
pnpm build
```

Then load `apps/extension/.output/chrome-mv3` as an unpacked extension. To create the Chrome Web Store ZIP:

```bash
pnpm package:extension
```

No environment file is required for the extension. Exa keys are entered during onboarding and stored only in that Chrome profile.

## For developers

The V2 runtime builds one compact `ArticleIndex`, creates an adaptive `AnalysisPlan`, and coordinates retrieval through a shared source ledger and evidence graph. Providers return candidate sources; bounded adjudication maps those candidates to article claims, and centralized validation is required before an assertion is shown in the report.

```text
Active article -> ArticleIndex -> AnalysisPlan -> retrieval -> evidence ledger
                                                        |
                                                        v
                                                   side panel report
```

Project structure:

```text
apps/extension/        WXT Manifest V3 extension and side panel
packages/contracts/    shared wire contracts and evidence types
packages/extraction/   article extraction and ArticleIndex construction
packages/intelligence/ planning, retrieval, validation, and report projection
docs/                   architecture, privacy, deployment, and project notes
```

Run the repository checks with:

```bash
pnpm verify
pnpm verify:release
pnpm audit --prod --audit-level=high
```

## Documentation and team

Start with [`docs/README.md`](docs/README.md), then read [`docs/architecture-v2.md`](docs/architecture-v2.md) for the implemented runtime, [`docs/privacy.md`](docs/privacy.md) for the reader-facing disclosure, and [`docs/public-deployment.md`](docs/public-deployment.md) for the release checklist.

Perspectica was created by:

- **Austin Morgan** — developer and AI orchestration;
- **Lathik Ram C.** — concept lead, UI design, and outreach;
- **Mathew Estis** — developer and project coordination;
- **Jordan Allen** — brand design and QA testing.

## License

Perspectica is released under the [MIT License](LICENSE).

