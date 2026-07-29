# Perspectica reader-output refinement

## Goal

Keep the existing compass and one-pass specialist architecture while making every
visible research statement concise, useful, and traceable to evidence that
survived server validation.

## Evidence-first reader copy

- A researched finding is visible only when at least one of its citation ids
  matches an accepted source.
- If validation removes a source referenced by generated copy, the matching
  sentence is removed too.
- When all generated sentences lose their sources, the server builds short
  fallback copy from the accepted source relationships instead of showing an
  uncited claim or reverting to the long source-card presentation.
- If validation removes any generated sentence, the section receives a neutral
  lead that does not mention discarded evidence.
- Bias findings follow the same id reconciliation against validated article
  evidence. Their canonical technique names appear as small text labels rather
  than cards.

## Editorial behavior

- Leads summarize the section in one short sentence and do not preview facts
  that are absent from the final findings.
- Supporting Information states what independent evidence corroborates.
- Contradicting Information states the concrete correction or limitation
  directly.
- Additional Context supplies only background necessary to understand a central
  claim and avoids phrases such as "unresolved points."
- Journalist Context may use an official professional profile when it materially
  clarifies that the writer regularly produces analysis, commentary, or
  specialized reporting. It does not convert job title, employer, or beat into
  an assumption about personal politics or credibility.

## Reader interface

- The political compass, axes, scoring, and disclosure remain unchanged.
- The sticky Perspectica masthead becomes more compact after the reader scrolls,
  reducing obstruction while keeping settings accessible.
- The sky remains strongest around the article header and fades into the paper
  background as the document continues, rather than staying fixed behind every
  section.
- Section spacing and source notes become slightly denser without changing the
  editorial visual system.

## Verification

- Tests cover strict structured-output schemas, citation loss after source
  validation, bias-copy reconciliation, deterministic source-backed fallback
  copy, and sticky-header state.
- Full formatting, type checking, unit tests, extension build, and API build
  must pass.
