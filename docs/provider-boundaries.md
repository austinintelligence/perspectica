# Provider boundaries

Perspectica has no Perspectica-operated API or hosted database. A report stays local except for
the configured provider and the bounded keyless discovery/public-page lanes described below.

## OpenAI / ChatGPT

The experimental community `login-with-chatgpt` device flow opens OpenAI's authorization page;
Perspectica never asks for an OpenAI password. When ChatGPT search is selected, the extension
uses the connected provider's supported web-search tool. It does not scrape or automate the
ChatGPT website, replay browser cookies, or load remote JavaScript.

## Exa

When Exa is selected, searches and source reads are sent directly to `https://api.exa.ai` with
the API key entered by the reader. The key is encrypted in the local vault and is not included in
logs, UI messages, report events, or page scripts.

## Free discovery and public pages

The Free provider uses bounded, best-effort discovery across GDELT DOC metadata, selected
publisher RSS, DuckDuckGo Instant Answer JSON, and topic-specific public metadata such as
Wikimedia or Crossref when relevant. These services receive the research query, not the reader's
credentials or browser cookies. Discovery metadata is a `search-summary` only; Perspectica must
fetch a limited public HTTPS source page before treating text as quotation-ready evidence. It does
not bypass paywalls, CAPTCHAs, robots restrictions, or login redirects.

## Data minimization

Only the active article's bounded URL, title, byline, visible text, links, publication metadata,
and research questions needed for the selected lane are sent. Provider responses are validated
for canonical URLs and exact excerpts before display. Provider privacy policies, retention, and
regional processing terms apply to data sent to those providers.

If ChatGPT or Exa is unavailable, Perspectica identifies the degraded state and may fall back to
Free, then to article-only analysis. The report preserves provenance and never presents a fallback
as if the requested provider completed it. Caches are isolated by ChatGPT account, Exa key
fingerprint, or the public Free scope.
