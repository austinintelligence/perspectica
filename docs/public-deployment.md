# Chrome Web Store release guide

Perspectica is distributed as a self-contained Manifest V3 Chrome extension. There is no API to
deploy and no recurring Perspectica hosting cost.

## Build

```sh
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level=high
pnpm verify:release
```

WXT writes the self-contained unpacked build to `apps/extension/.output/chrome-mv3` and the
store-ready ZIP under `apps/extension/.output`. Live development uses the separate
`apps/extension/.output/chrome-mv3-dev` directory because it depends on the local WXT/Vite server.
Only the production directory and ZIP are release artifacts.
`verify:release` also inspects the generated package and rejects local environment files,
databases, datasets, and other development-only artifacts.

## Pre-release inspection

1. Open the generated `manifest.json`.
2. Confirm there is no `content_scripts` entry.
3. Confirm the two narrow OpenAI origins and `<all_urls>` appear only in
   `optional_host_permissions`. Login requests only the OpenAI origins; article
   access is a separate, explicit all-sites grant.
4. Confirm there is no localhost endpoint or remote script.
5. Load the unpacked build in a fresh Chrome profile.
6. Test device authorization with remember-me both enabled and disabled.
7. Restart Chrome and confirm the remembered session restores.
8. Test Exa setup, ChatGPT-search capability detection, model selection, article extraction,
   cancellation, and disconnect.
9. Test the one-time article-access explanation, grant, denial, retry, and Chrome-level revocation.
10. Clear extension data and confirm a clean first-run experience.

## Store disclosure

The listing and privacy form should accurately disclose:

- optional broad standard-website access, requested during onboarding and used only to extract
  the active page after the user requests an analysis
- transmission of article text and research queries to the user's selected providers
- local encrypted storage of a ChatGPT refresh token when remember-me is enabled
- local encrypted storage of an Exa API key when Exa is selected
- no Perspectica-operated server, sale of data, advertising, or cross-site tracking
- the experimental nature of the community ChatGPT device-flow integration

Publish [`privacy.md`](privacy.md) at a stable public URL and use that URL in the Chrome Web Store
privacy field.

## Updates

Keep the extension ID stable by publishing updates through the same Chrome Web Store item. Chrome
preserves extension local storage across ordinary updates, so remembered sessions normally
continue working. A storage-schema migration must be additive, tested against the prior release,
and able to recover by asking the user to reconnect without exposing secret material.

## Rollback

Chrome Web Store releases cannot rely on a hosted rollback switch. Keep the prior ZIP and source
tag. If provider behavior changes, publish a fixed version promptly and make failures explicit in
the UI. Never silently redirect credentials through a newly introduced server.
