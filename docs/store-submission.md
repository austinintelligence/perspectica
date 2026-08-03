# Chrome Web Store submission

Use the tagged, self-contained ZIP from GitHub Releases. Do not upload the development directory
or a ZIP produced while a WXT dev server is running.

## Submission checklist

1. Run `pnpm verify:release`, `pnpm audit --prod --audit-level=high`, and the installer tests.
2. Verify `manifest.json` against [`permissions.md`](permissions.md): no required host access,
   persistent content script, localhost origin, or remote executable code.
3. Verify `SHA256SUMS`, the SBOM, and the provenance attestation for the exact ZIP.
4. Publish [`privacy.md`](privacy.md) at a stable HTTPS URL and use that URL in the store
   privacy field.
5. Describe optional all-sites access, active-page extraction, provider transmission, encrypted
   local credentials, bounded GDELT/DuckDuckGo JSON discovery and public-page reads, and the
   absence of tracking or a Perspectica backend.
6. Test install, update, disconnect, reset, denial/revocation of host access, and uninstall in a
   fresh Chrome profile.

## Conditional policy gate

Before submitting each version, search the packaged source and dependencies for policy-sensitive
behavior. **Stop submission and request a policy review if a version automates the ChatGPT web
UI, replays ChatGPT browser cookies, or parses DuckDuckGo (DDG) HTML/search-result pages.** Those
patterns can violate provider or Chrome Web Store policies and are not an acceptable fallback.
Use documented provider APIs/tools and attributable sources instead.

The current implementation uses a user-directed community device flow and the selected
provider's web-search tool; it does not automate the ChatGPT website or parse DDG HTML. This
statement must be rechecked whenever provider code or dependencies change.

## Store listing copy constraints

Do not claim that Perspectica determines truth, permanently labels people/publications, or
guarantees provider availability. Describe it as article-level source-grounded context and make
the experimental ChatGPT connection explicit.
