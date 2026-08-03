# Frequently asked questions

## Does Perspectica decide whether an article is true?

No. It identifies article framing, verifies bounded claims against accessible sources, and exposes
supporting, contradicting, and contextual evidence so the reader can make a better-informed
judgment.

## Is the political label permanent?

No. The `-3…+3` placement describes the current article. Article framing contributes half of the
evidence; verified publication and journalist context share the other half. Context cannot invent
a position that is absent from the article.

## Why is there an Unclear result?

Unclear is reserved for a run where the article, publication history, journalist work, and outside
comparison all lack a defensible political signal. It is not a generic error or fallback for a
failed provider.

## What leaves my device?

Nothing leaves the device when the article preview opens. After Analyze, bounded article context
and research queries go to the configured inference/search providers, and the extension may fetch
validated public HTTPS sources. See [privacy](privacy.md) and [provider boundaries](provider-boundaries.md).

## Why does the extension need all-sites access?

News domains cannot be known before the reader opens them. The optional permission lets packaged
code read the active article and bounded public evidence pages only after a user-started analysis.
Perspectica does not register an always-running content script.

## Is a Perspectica account or subscription required?

There is no Perspectica account or hosted backend. Inference uses the reader's connected ChatGPT
account. Free research requires no search key; Exa is optional and uses the reader's own key.

## Can it bypass paywalls or login pages?

No. Perspectica does not bypass paywalls, CAPTCHAs, robots restrictions, sign-in gates, or protected
browser pages. Evidence requiring inaccessible source text cannot be quoted as verified text.

## Which browser should I use?

Current Chrome is the primary target. Current Edge and Brave are tested Chromium targets on macOS
and Windows. Firefox and Safari do not provide the required compatible Side Panel and Offscreen APIs.
