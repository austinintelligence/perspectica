# Developer helper guide

The repository is a pnpm workspace. The normal loop is:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Keep `pnpm dev` running while the developer build at
`apps/extension/.output/chrome-mv3-dev` is loaded. For a self-contained build, run `pnpm build`
and load `apps/extension/.output/chrome-mv3`; do not load both output directories at once in the
same browser profile.

Useful checks:

| Command                                                          | Purpose                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm verify`                                                    | Formatting, type checking, tests, and workspace builds.                              |
| `pnpm verify:release`                                            | `verify`, production WXT build, ZIP packaging, and package inspection.               |
| `pnpm check:extension-package`                                   | Re-checks the generated MV3 manifest and forbidden artifacts.                        |
| `pnpm dataset:spectrum:validate`                                 | Validates the checked-in aggregate calibration dataset.                              |
| `cargo test --manifest-path tools/installer/Cargo.toml --locked` | Tests checksum, ZIP-slip, browser detection, marker, repair, and uninstall behavior. |
| `cargo run --manifest-path tools/installer/Cargo.toml -- guide`  | Prints the visible Load unpacked guidance without changing browser policy.           |

Keep `.env.local`, browser profiles, `.output`, raw article corpora, provider keys, and exported
logs out of commits. New host permissions, provider calls, or retention behavior must update the
corresponding documents under `docs/` before a pull request is opened.
