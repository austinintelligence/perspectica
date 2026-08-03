# Perspectica installer helper

This small Rust helper is the optional GitHub developer-channel installer. It verifies a release
ZIP and named SHA-256 entry, rejects oversized responses, HTTPS downgrades, ZIP-slip paths and
symlinks, then replaces one fixed directory through a recoverable staging operation:

- macOS: `~/Library/Application Support/Perspectica/extension`
- Windows: `%LOCALAPPDATA%\Perspectica\extension`
- other Unix systems: `~/.local/share/Perspectica/extension`

It detects Chrome, Edge, and Brave executable/profile locations only to tailor guidance. Running
the helper without a command lets the user choose a detected browser, opens that browser's
extensions page, and reveals the fixed extension directory. It never writes browser policy,
registry keys, profile preferences, or enterprise deployment settings. The final browser action
is always a visible **Load unpacked** selection by the user.

```sh
cargo test --manifest-path tools/installer/Cargo.toml --locked
cargo run --manifest-path tools/installer/Cargo.toml
cargo run --manifest-path tools/installer/Cargo.toml -- guide
cargo run --manifest-path tools/installer/Cargo.toml -- download-release \
  --asset-url https://github.com/OWNER/REPO/releases/download/v0.1.0/perspectica-extension-v0.1.0.zip \
  --checksum-url https://github.com/OWNER/REPO/releases/download/v0.1.0/SHA256SUMS \
  --asset-name perspectica-extension-v0.1.0.zip --version v0.1.0
```

`repair` re-verifies and replaces the fixed directory, `update-marker` changes only the local
metadata marker, and `uninstall` removes a directory only when that marker is present.

`update-latest` reads the newest public GitHub release, selects its named extension asset and
`SHA256SUMS`, verifies the exact checksum, and stages the replacement. `enable-updates` is an
explicit opt-in that copies this nonresident helper into Perspectica's support directory and adds
a login/daily check (a LaunchAgent on macOS or user scheduled tasks on Windows). It never reloads
or updates a browser silently. Run `disable-updates` before removing the helper.

## Release usage

1. Download the helper archive for the operating system, the versioned extension ZIP, and
   `SHA256SUMS` from the same GitHub release.
2. Verify the helper archive against `SHA256SUMS` before opening it.
3. Run `download-release` with the release's HTTPS asset/checksum URLs, or use `install` with a
   locally downloaded ZIP and its exact digest.
4. Run `setup --browser chrome`, `setup --browser edge`, or `setup --browser brave`. If no browser
   is specified, the interactive helper lists detected choices.
5. Enable Developer Mode and select **Load unpacked** once. Later verified repairs reuse the same
   directory; reload the extension card to pick up changed files.

The beta helper binaries are not yet notarized or Authenticode-signed. Gatekeeper and SmartScreen
may warn on first launch. Prefer the Chrome Web Store consumer build; never disable operating-system
security globally to run this helper.
