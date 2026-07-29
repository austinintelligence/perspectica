# Contributing to Perspectica

## Local setup

1. Install Node.js 22+ and pnpm 9.15.4+.
2. Run `pnpm install`.
3. Copy `apps/api/.env.local.example` to `apps/api/.env.local` and set your own `EXA_API_KEY`.
4. Run `pnpm dev:api` and `pnpm dev:extension` in separate terminals.

Never commit `.env` files, local databases, exported ChatGPT sessions, scraped article corpora,
or generated presentation assets.

## Before opening a pull request

Run:

```sh
pnpm verify
pnpm audit --prod --audit-level=high
```

Keep changes focused, add or update tests when behavior changes, and preserve the product's
evidence-first framing. Political-spectrum labels are article-level research outputs, not fixed
ratings of a publication or person.
