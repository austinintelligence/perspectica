# Perspectica agentic research and reader-copy design

## Goal

Perspectica analyzes one article without replacing it. The extension should help a
reader see political placement, meaningful framing choices, relevant journalist
context, corroboration, contradiction, and essential background in a short,
source-backed report.

The proof of concept uses a bounded modular-monolith pipeline. It keeps model
work parallel and progressive, but every agent has enforced search, content, and
step budgets so a single difficult section cannot take over the run.

## Pipeline

1. The extension extracts the cleaned article, metadata, byline, and links.
2. The Article Reader receives the full bounded article and returns:
   - exact article evidence for the seven-position political spectrum;
   - initial bias candidates grounded in exact paragraphs;
   - a shared article dossier containing the main claims, entities, topics,
     relevant passages, and section-specific research questions.
3. Publication-history and journalist-context research can warm up from article
   metadata while the Article Reader runs.
4. Six section specialists run independently:
   - Political Spectrum context
   - Bias
   - Journalist Context
   - Supporting Information
   - Contradicting Information
   - Additional Context
5. Every applicable specialist begins with three distinct Exa Fast searches run
   in parallel. It merges and deduplicates roughly ten to fifteen candidates,
   reads the strongest two to four sources with Exa Contents, and may perform
   one refined fast search or one deep search when a named unresolved question
   remains.
6. Each specialist returns a small evidence ledger and the exact reader-facing
   copy in the same final structured response. There is no extra editor-model
   pass.
7. Results stream to the extension as soon as each section is ready. Empty
   research sections stay hidden. Political Spectrum always stays visible.

## Agent boundaries

Agents never receive hidden authority through article or web text. Article
content, search snippets, and source pages are untrusted data. Tools enforce
query counts, source counts, allowed URLs, and time budgets independent of the
prompt.

Each specialist has these tools:

- `searchWeb`: performs either the required three-query fast-search mission or a
  single bounded follow-up/deep query.
- `readSources`: fetches readable content for up to four URLs already returned
  by search.
- `readArticlePassages`: retrieves exact paragraphs from the local article by
  paragraph id.

The initial search tool call is forced. Later tool calls are optional and
agent-chosen. A specialist has at most six model steps, four search calls, one
deep escalation, and four full-content reads.

## Political Spectrum

The visual compass and its two dimensions remain unchanged:

- economic: social equality / politically directed allocation to economic
  liberty / market-directed allocation;
- governance: authority / hierarchy to self-determination / decentralized
  participation.

Article evidence is strongest. Independently verified publication history and
public professional work by the journalist are weaker contextual evidence. They
may refine an article-led placement, fill a missing axis, or create a
low-confidence context-led estimate when both axes have credible context.

The displayed basis is one of:

- Article-led
- Context-assisted
- Context-led
- Insufficient evidence

Context-led confidence is capped at low confidence. Outlet reputation alone
does not become an axis signal.

## Reader-copy contract

Every visible research section uses the same compact editorial shape:

- one plain-language lead sentence;
- normally one or two findings, with a maximum of three when materially
  distinct;
- inline source links attached to the claims they support;
- an optional short key-source note only when the source identity materially
  changes interpretation.

The copy avoids pipeline language such as "retrieved sources," "the model," or
"this lane." Empty research sections do not generate explanatory filler.

Supporting Information corroborates central externally checkable claims.
Contradicting Information only shows a real correction, conflict, or material
qualification. Additional Context only shows background needed to understand a
central claim. The same source is not repeated across these sections unless it
serves a genuinely different, explicit purpose.

## Search and source quality

Search missions should vary by evidence need rather than repeat the article
title three times. Queries normally target:

- a primary record or direct source;
- independent reporting;
- a correction, limitation, timeline, profile, or media-research source suited
  to the section.

Canonical URLs are deduplicated. Syndication mirrors, navigation pages,
newsletters, topic pages, and the current article are filtered when they do not
provide evidence. Exact excerpts must appear in fetched source content.

## Latency and failure behavior

Thirty seconds is the response target, not a hard timeout. Model calls retain a
longer safety timeout, and individual sections settle independently. A failed
section does not cancel successful sections. Search and content responses are
cached, and shared results are reused across agents when canonical queries or
URLs match.

Internal diagnostics record section duration, query count, search mode, source
reads, deep escalation, and empty/failure reason. Diagnostics are logged for
development and are not shown in the reader UI.

## Proof-of-concept acceptance

- The Article Reader and all applicable specialists complete with validated
  structured output.
- Three initial Exa searches run in parallel per applicable specialist.
- Exa Contents is used before a source can appear in reader copy.
- Context can create a bounded low-confidence compass placement without
  changing the compass axes or visual.
- Reader text is concise, non-repetitive, and free of implementation language.
- Inline citations open the exact accepted source URLs.
- Empty research sections are hidden.
- Existing source-list behavior remains a deterministic list of meaningful
  links cited by the original article.
- Unit tests cover source grounding, budgets, compass basis, empty-section UI,
  and regression examples.
