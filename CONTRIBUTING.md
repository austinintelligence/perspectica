# Contributing to Perspectica

## Local setup

1. Install Node.js 22+ and pnpm 9.15.4+.
2. Run `pnpm install`.
3. Run `pnpm dev`.
4. Load `apps/extension/.output/chrome-mv3-dev` once in the regular Chrome profile.
5. Connect your own ChatGPT account and configure Exa or supported ChatGPT web search.

Leave `pnpm dev` running while using the live developer extension. WXT development builds import
from its local Vite server and support HMR and extension reloads.

For a self-contained unpacked build, run `pnpm build` and load
`apps/extension/.output/chrome-mv3`. Production and development outputs intentionally use separate
directories so a stopped development server cannot leave the stable extension blank.

No local API or database is required.

## Engineering rules

- Never commit `.env` files, provider keys, exported sessions, local extension profiles, raw
  article corpora, build output, or screenshots containing private data.
- Keep network permissions narrow and explain every new host permission.
- Keep all-sites article access optional and user-initiated during onboarding.
- Do not add remote executable code; Chrome Web Store MV3 builds must contain all application
  code.
- Keep credentials in the vault/background boundary. UI components and injected page scripts
  must never receive them.
- Preserve exact-URL and exact-excerpt validation for research evidence.
- Treat political-spectrum labels as article-level outputs, not fixed ratings of people or
  publications.
- Add tests for protocol, storage, orchestration, and validation changes.

## Before opening a pull request

```sh
pnpm verify
pnpm audit --prod --audit-level=high
pnpm package:extension
```

Inspect the generated manifest and ZIP. Confirm that they contain no localhost permission, secret,
environment file, remote script, raw corpus, or personal/team asset.
