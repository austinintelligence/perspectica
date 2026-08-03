## Summary

<!-- What changed and why? Keep runtime, permissions, and release-impact details explicit. -->

## Validation

- [ ] `pnpm verify`
- [ ] `pnpm verify:release` (when packaging or manifest behavior changes)
- [ ] `pnpm audit --prod --audit-level=high`
- [ ] `cargo test --manifest-path tools/installer/Cargo.toml --locked` (when installer changes)

## Security and privacy review

- [ ] No credentials, raw article corpus, local profiles, or generated release output committed.
- [ ] New host permissions are documented in `docs/permissions.md` and requested only with a user gesture.
- [ ] Provider/network behavior is documented in `docs/provider-boundaries.md`.
- [ ] This change does not automate ChatGPT UI, parse DuckDuckGo HTML, or add remote executable code.
- [ ] Store listing, privacy, threat-model, or retention docs updated if behavior changed.

## Release notes

<!-- Mention migration, rollback, browser support, and user-visible behavior when relevant. -->
