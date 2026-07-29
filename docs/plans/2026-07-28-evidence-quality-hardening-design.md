# Perspectica Evidence Quality Hardening

## Decision

Perspectica uses layered evidence quality controls instead of adding a second editorial model
pass. Deterministic extraction and validation handle facts the application can know directly;
the model handles interpretation inside narrower, section-specific instructions.

This keeps the existing parallel pipeline and its latency while making the report sections
more distinct and conservative.

## Extraction boundary

- Prefer a visible journalist byline, then NewsArticle structured data, then author metadata.
- Reject URLs, social profiles, email addresses, and newsroom account names as journalists.
- Keep links attached to article paragraphs, but remove newsletter, signup, subscription, and
  promotional destinations from Works Cited.
- Allow a directly cited public statement on a social platform because it can be a source used
  by the article.

## Article Lens boundary

- The political compass measures only the defined economic and domestic-governance axes.
- Diplomatic autonomy, multilateralism, international institutions, alliances, and foreign
  policy do not count as self-determination or authority by themselves.
- Quoted rhetoric belongs to the quoted speaker. It becomes article-bias evidence only when a
  demonstrable editorial selection or framing choice is identified.
- Bias labels use the product's canonical technique names, with at most one finding per
  technique.
- Research claims must be explicit, externally checkable article claims rather than opinions,
  insults, or model-created synthesis.

## Research lane boundary

- Supporting Information accepts only sources that directly support a supplied claim.
- Contradicting Information accepts only direct contradictions or material qualifications. A
  source's silence or narrower coverage is not contradictory evidence.
- Additional Context accepts only definitions, timelines, institutional processes, or history
  necessary to interpret the article. It is not an overflow supporting section.
- Wrong-lane relationship types are rejected after model generation even when the URL and
  excerpt are otherwise valid.

## Presentation

An unclear political spectrum no longer shows a meaningless `0% confidence` label or repeats
the same insufficiency sentence. When one-axis signals survive validation, they are labeled
as signals considered rather than placement evidence.

## Regression target

For a neutral BBC report about a US walkout at the United Nations:

- the journalist is Olivia Ireland rather than a BBC Facebook URL;
- diplomatic behavior does not produce a political-compass point;
- attributed insults are not presented as BBC-authored loaded language;
- AP confirmation remains Supporting Information;
- the same AP confirmation cannot appear as Contradicting Information;
- confirmation does not repeat in Additional Context;
- newsletter signup links do not appear in Works Cited;
- the linked French UN mission statement may remain as a cited source.
