# Streaming UI Refinement

## Goal

Make the Perspectica report feel continuously responsive while preserving its quiet editorial design and structured analysis pipeline.

## Selected approach

Perspectica keeps its existing NDJSON analysis-event protocol. The report is not converted into a chat interface because each result has a stable product meaning: political spectrum, bias, journalist context, supporting information, contradicting information, additional context, and works cited.

The UI adopts the useful AI SDK UI patterns instead:

- explicit waiting, loading, ready, empty, and error states;
- independent progressive sections;
- transient loading presentation replaced by persistent completed content;
- content rendered as typed, accessible parts rather than one monolithic response.

When a complete structured section arrives, its short text fields reveal by word over 150–580 milliseconds. The complete text remains available immediately to assistive technology, so screen readers do not announce every word separately. Reduced-motion users receive the entire result immediately.

## Motion

`motion/react` handles section state transitions and the short streaming caret. Motion is limited to opacity and transforms:

- loading skeleton to completed section: 160 milliseconds;
- section entrance: five-pixel rise and fade;
- streamed text: rapid word reveal with a temporary gold caret;
- compass interaction remains unchanged.

Loading skeletons use opacity and scale instead of animating a painted gradient. All existing motion respects `prefers-reduced-motion`.

## Masthead and atmosphere

The Perspectica masthead becomes sticky with an eight-pixel safe-area-aware offset. It remains visible while the report scrolls, keeping settings reachable and maintaining product identity without adding navigation.

The atmosphere is rendered as a fixed viewport layer instead of a finite document strip. The sky occupies the upper viewport and fades into the paper color by 740 pixels. This prevents a plain white strip from appearing above the interface at deeper scroll positions.

The large gap between the masthead and article title is reduced from as much as 170 pixels to at most 88 pixels. The title still has enough sky around it to remain editorial rather than dashboard-like.

## Validation

- Pure tests cover streaming chunk splitting, duration limits, and progress bounds.
- Existing report-state and accessibility behavior remain intact.
- TypeScript, formatting, all tests, extension build, and API build must pass.
- Visual QA checks the initial viewport, a scrolled viewport, the sticky masthead, and the continuous sky-to-paper transition.
