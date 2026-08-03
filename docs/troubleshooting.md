# Troubleshooting

Perspectica is a self-contained side-panel extension. It does not require a local API, a terminal,
or Codex after installation.

## The side panel is blank

1. Confirm that the production directory, not the development directory, is loaded:
   `apps/extension/.output/chrome-mv3`.
2. Select **Reload** on the Perspectica card in `chrome://extensions` (or the equivalent Edge or
   Brave page).
3. Open the extension's **Errors** view. A development build that was loaded after its local Vite
   server stopped will be blank; rebuild and load the production directory.

## Perspectica cannot read the page

- Open a normal public HTTPS article, then reopen the side panel.
- Grant article access when Perspectica asks. Browser-internal pages, PDF viewers, local files,
  extension pages, sign-in walls, and protected tabs cannot be injected.
- If permission was denied earlier, restore site access from the extension's browser settings.

## Analyze is disabled

The Analyze screen names the missing prerequisite. Check that the article preview contains usable
text, ChatGPT is connected, the chosen model is available to the account, and the selected search
provider is ready. The Free provider needs no key; Exa requires a valid user-supplied key.

## A report stopped or a section failed

- Open Diagnostics and copy the selected run's redacted support log. Read the warning before
  exporting full diagnostics because article excerpts and model output may be included.
- Retry only the failed section when that control is available. Completed sections and accepted
  evidence are retained.
- An interrupted compatible run offers Resume. A run from an incompatible older schema offers
  Restart instead of replaying mismatched events.

## Login stopped working

Disconnect and reconnect ChatGPT from Settings. Perspectica never asks for the ChatGPT password;
authorization occurs on OpenAI's page. Model availability and the experimental community device
flow can change independently of the extension.

## The GitHub helper is blocked

The first developer-channel binaries may be unsigned. Verify the release checksum and provenance
before using the documented Gatekeeper or SmartScreen override. The helper only writes its marked
Perspectica directory and opens browser guidance; it does not change enterprise policy or browser
profiles. The Chrome Web Store remains the recommended consumer path.

## Resetting local data

Use Diagnostics to clear retained runs, disconnect ChatGPT, remove the Exa key, then clear the
extension's local data from browser settings. Uninstalling the extension removes its Chrome-profile
storage. Store and developer extension IDs intentionally keep separate credentials and history.
