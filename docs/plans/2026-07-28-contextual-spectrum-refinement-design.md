# Contextual Spectrum Refinement

> Superseded on July 29, 2026 by
> `2026-07-29-seven-position-spectrum-design.md`. This file remains as a record
> of the earlier two-axis prototype.

## Decision

The adopted political compass stays unchanged.

- Economic axis: social equality to economic liberty
- Governance axis: authority to self-determination
- Existing point, labels, quadrants, hover behavior, and expandable UI remain unchanged

Publication history and a journalist's verified public professional work are added only as contextual evidence for placement. They do not create a new compass, new axes, or a publication-wide political score.

## Evidence order

1. The article's demonstrated framing and endorsed policy position remain the primary evidence.
2. Independent research about the publication's durable historical orientation may weakly refine an ambiguous placement.
3. Relevant patterns in the named journalist's public professional work may refine it more weakly.
4. If the combined evidence does not cover both adopted axes, the result stays `Unclear`.

## Influence limits

When article evidence and both context types are available:

- Article: 75%
- Publication history: at most 18%
- Journalist work: at most 7%

Missing context does not reduce the article to 75%; the unused contextual share returns to the article. A context-only estimate must cover both axes and is always low confidence.

Generic left/right outlet labels can produce at most one weak economic-axis signal. A governance signal normally requires source text that specifically addresses authority, hierarchy, civil liberties, or decentralized participation. An independently supported, durable named quadrant tradition may be mapped weakly onto the existing quadrant definitions, with each inferred signal capped at 25%. Employer alone, one article, topic assignment, private information, and unsupported stereotypes are excluded.

## Parallel pipeline

At analysis start:

- Article Lens analyzes the supplied article.
- Publication-history research begins.
- Journalist-work retrieval begins.
- Journalist Context begins from the same journalist retrieval.

The journalist retrieval request is identical across both consumers, allowing the Exa adapter to coalesce it into one network request. Article Lens emits the first spectrum result as soon as it is ready. A second `compass.ready` event is emitted only when verified contextual signals exist, replacing the provisional result without changing the UI.

Supporting, contradicting, and additional-context lanes begin as soon as Article Lens produces bounded research claims. They continue in parallel.

## Output quality rules

- Quoted political rhetoric is not automatically article bias.
- Cherry-picking cannot be inferred only because broader context is absent.
- Source-selection requires a demonstrably one-sided source pattern in the supplied article.
- A research source appears in only one evidence lane, with priority given to contradicting or qualifying evidence over supporting evidence, and supporting over additional context.
- Works Cited contains meaningful links used in the article, not newsletter links or same-site category, person, topic, tag, and search pages.
- Repeated byline prefixes and duplicated publication suffixes are removed before analysis.

## Fox example

For the supplied Fox News article:

- The byline becomes `Ashley J. DiMella`.
- Historical Fox News orientation may weakly refine the existing compass only when independently verified and mappable to an adopted axis.
- Journalist work is used only when relevant public professional evidence is verified.
- The recordings excerpt is not labeled cherry-picking merely because the article does not provide the entire recording.
- PBS cannot appear in both Supporting Information and Contradicting Information.
- The Fox News Obama category page is excluded from Works Cited.
