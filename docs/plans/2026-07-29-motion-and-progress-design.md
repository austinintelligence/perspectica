# Motion and progress design

## Goal

Make the extension feel responsive while research streams in, without turning an editorial reading surface into a dashboard.

## Approved interaction model

- A clear, event-driven status block appears only while analysis is active. Its copy follows actual report milestones: reading the article, comparing coverage, checking source context, and preparing the report. A smaller line explains the immediate task.
- A gold pulse and short progress line signal work without claiming a precise completion time.
- The political-spectrum control uses the normal report-row pattern: icon at left, a flexible vertically centered label area, and its circular plus/minus action aligned to the far right. Opening it expands the report in place; closing reverses the same motion.
- Streamed section states use existing short fades and rise transitions. Settings opens and closes as a light overlay transition.
- Every new animation respects `prefers-reduced-motion`.

## Verification

- Unit-test the progress copy selection.
- Type-check and build the extension after adding Motion components.
- Keep the status UI out of completed, partial, and error reports.
