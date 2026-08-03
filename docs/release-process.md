# Release process

Releases are reproducible, store-oriented artifacts. Do not commit credentials, signing keys,
provider sessions, raw article corpora, or generated `.output` directories.

## Required checks

```sh
pnpm install --frozen-lockfile
pnpm verify:release
pnpm audit --prod --audit-level=high
cargo test --manifest-path tools/installer/Cargo.toml --locked
```

Release tags must use `vX.Y.Z`. The tag workflow rejects a release unless the root package,
extension package, effective WXT manifest version, and generated production manifest all match the
tag's `X.Y.Z` value. Keep the package and manifest version sources aligned; the workflow never
silently renames a mismatched build.

Inspect the generated manifest and ZIP with [`docs/permissions.md`](permissions.md) and
[`scripts/check-extension-package.mjs`](../scripts/check-extension-package.mjs). Confirm that
the version, permission disclosure, privacy URL, and four team credits agree with the release
notes.

## GitHub release artifacts

The tag workflow builds the self-contained extension ZIP, a universal macOS developer helper, and
a Windows x64 developer helper. It emits one `SHA256SUMS`, creates an SPDX SBOM for the extension,
and publishes GitHub artifact attestations. A release is not ready for store upload until these
artifacts are present and every checksum verifies after download.

No workflow signs the Chrome package or helper binaries with a private key. Chrome Web Store
signing remains a store-controlled step; provenance attests the CI-produced files only. The first
helper releases are an explicitly labeled unsigned beta until Apple notarization and Windows
Authenticode credentials are configured.

The helper is a GitHub developer-channel convenience, not a consumer sideload bypass. It verifies
and stages one fixed unpacked directory, opens browser guidance, and optionally configures a
nonresident login/daily update check. The reader still enables Developer Mode and chooses Load
unpacked once; no release may add browser-policy, registry-profile, or silent-install behavior.

## Rollback

Keep the prior ZIP, checksum file, SBOM, and source tag. If a provider or browser regression is
found, unlist or roll back through the same store item and publish a fixed version. Never add a
new credential relay or silent browser policy as an emergency workaround.
