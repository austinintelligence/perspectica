# Release and benchmark gates

These scripts are intentionally independent of the extension runtime. They inspect a built WXT package, count repository source, and measure the local build process. None of them reports Chrome startup, interaction, network, or browser rendering performance.

Run from the repository root after `pnpm build`:

```sh
node scripts/benchmarks/extension-security-scan.mjs
node scripts/benchmarks/report-extension-size.mjs
node scripts/benchmarks/report-dependencies-loc.mjs
```

The first two accept `--output <directory>` for a different unpacked WXT output, `--json` for machine-readable output, and the size report accepts `--max-total-mib <number>` as an optional release budget. `extension-security-scan.mjs` checks MV3 structure, the approved permissions/host grants, localhost leakage, CSP safety when a CSP is present, dynamic code evaluation, and remote scripts in HTML.

For a reproducible build-process timing sample (not a browser metric):

```sh
node scripts/benchmarks/measure-extension-build.mjs
```

## Merge measurements

The three rows below were measured on August 3, 2026, on the same checkout machine. The local
snapshot and remote V2 rows were built in clean detached worktrees; the merged row is the current
`codex/v2-editorial-merge` checkout. WXT's build time is process timing only.

| Measurement                     | Local editorial snapshot `7b02775` |   Remote V2 `ab50cb2` |       Merged checkout |
| ------------------------------- | ---------------------------------: | --------------------: | --------------------: |
| Passing test files / tests      |                           31 / 223 |              26 / 109 |              37 / 164 |
| Unpacked files                  |                                 24 |                    15 |                    16 |
| Unpacked bytes                  |              1,265,565 (1.207 MiB) | 1,143,059 (1.090 MiB) | 1,216,425 (1.160 MiB) |
| Initial side-panel chunk        |                          336.61 kB |             245.93 kB |             258.16 kB |
| WXT production build            |                            2.249 s |               1.958 s |               1.992 s |
| Release ZIP                     |                          406.02 kB |          Not recorded |             374.25 kB |
| Production source files / lines |                        49 / 15,419 |           71 / 12,051 |           77 / 15,479 |
| Test files / lines              |                         31 / 7,472 |            26 / 3,737 |            37 / 5,259 |

The merged build is 49,140 bytes smaller unpacked than the editorial snapshot, its initial
side-panel chunk is 78.45 kB smaller, and its release ZIP is 31.77 kB smaller. It is 73,366 bytes
larger unpacked than remote V2 because it includes the editorial routes, provider setup, encrypted
retention, diagnostics, and the lazy 8.16 kB Settings route. The initial side-panel chunk remains
below the locked 260 kB release gate.

`pnpm test:coverage` reports 55.66% statements and 65.65% branches across the whole repository. A
direct aggregation of `coverage-final.json` for `packages/intelligence` reports 79.15% statements
and 66.40% branches. These measured results do not satisfy the earlier aspirational 80% branch
target, so no repository-wide 80% coverage claim is made.

## Browser-rendered checks

The production side panel was rendered at 320, 360, 420, and 520 CSS pixels with no horizontal
overflow. At 320px, the standalone masthead control measured 44×44px. Settings route replacement,
Analysis/Sources/Account tab navigation, and Arrow-key tab focus were exercised in the rendered
build. The unpacked Manifest V3 package loaded in local Google Chrome and Brave profiles. Microsoft
Edge was not installed on the reference machine and remains unverified there.

Authenticated provider latency, time to first model chunk, memory, and CPU were not measured in
this pass because they require a consented live account/provider run. The deterministic tests and
package benchmarks must not be presented as substitutes for those measurements.

The dependency/LOC report scans `apps/` and `packages/` while excluding generated or vendored directories (`node_modules`, `.next`, `.output`, `.wxt`, `coverage`, `dist`, `target`, and `.turbo`).
