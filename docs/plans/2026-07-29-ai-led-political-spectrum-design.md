# AI-led political-spectrum design

## Purpose

Perspectica labels the political framing a reader is most likely to receive
from a particular article. It is not a permanent rating of an outlet, and it
is not a text-only classifier.

## Evidence model

The Article Lens supplies validated, exact article evidence. That evidence is
normally 50% of the final score. The political-spectrum specialist researches
the remaining context, then selects an article weight between 40% and 60% with
a short structured rationale.

The research share can include independently documented publication history,
recurring public journalist work, comparable coverage from the same outlet or
author, and independent coverage of the same event or issue. The specialist
chooses the mix; the server removes invalid sources and renormalizes the
remaining shares before scoring.

## Conflict policy

A durable independently documented publication pattern normally outweighs one
ambiguous article. A current article can depart from its outlet when it has an
explicit contrary editorial position or at least two to three validated
contrary article signals. Disagreement does not create an `Unclear` result; it
reduces confidence.

## Required research

Each spectrum pass begins with three complementary searches: independent
orientation or standards research, related outlet or author coverage, and
independent coverage of the same issue. It reads three to five sources first,
then expands toward ten only when evidence conflicts, the article is thin, or
confidence remains low.

## Reader experience

The extension remains simple. It shows the placement, confidence, plain
language explanation, and source-backed evidence in the expandable spectrum
panel. AI-selected weights and the internal rationale are retained for
validation and debugging, not shown as UI clutter.
