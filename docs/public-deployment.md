# Public repository and deployment guide

## What can be public

The application source, implementation plans, aggregate spectrum summary, and this deployment
guide can be published. The repository intentionally ignores local environment files, SQLite
session storage, generated presentations, screenshots, and raw calibration corpora. The raw
corpora can contain third-party article text and should be rebuilt locally using credentials you
control rather than committed to GitHub.

## Local proof-of-concept setup

```sh
pnpm install
cp apps/api/.env.local.example apps/api/.env.local
pnpm dev:api
pnpm dev:extension
```

Set `EXA_API_KEY` in the copied API environment file. The extension uses
`http://localhost:3000` by default. Load the built package from
`apps/extension/.output/chrome-mv3` through `chrome://extensions`.

## Hosted deployment prerequisites

This proof of concept can be built against a hosted API, but it is not a turnkey multi-tenant
service. Before sharing a hosted build with users:

1. Serve the API through HTTPS and configure a persistent, private database volume.
2. Set a unique, high-entropy `PERSPECTICA_SESSION_SECRET`; the API now refuses to start in
   production without one.
3. Set `PERSPECTICA_COOKIE_SECURE=true`.
4. Set `PERSPECTICA_EXTENSION_ORIGIN` to the exact origin of the extension build you distribute.
5. Build the extension with the API origin exported, so its manifest contains the required host
   permission:

   ```sh
   WXT_API_BASE_URL=https://api.example.com pnpm --filter @perspectica/extension build
   ```

6. Do not commit the resulting `.output` folder or any deployment environment file.

The community `login-with-chatgpt` device-flow integration is experimental. Obtain informed user
consent, keep users' tokens on the server side, and do not describe it as an official OpenAI
identity product.

## GitHub release checklist

```sh
pnpm verify
pnpm audit --prod --audit-level=high
git status --ignored
```

Confirm that no `.env` file, database, build output, raw corpus, or personal/team asset appears
in the staged files. Create the GitHub repository as public only after this check passes.
