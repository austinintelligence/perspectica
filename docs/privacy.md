# Perspectica privacy notice

Last updated: July 29, 2026

Perspectica is a Chrome extension that helps a reader examine the news article open in the active
tab. Perspectica does not operate a backend service.

## Data Perspectica processes

When you choose to connect ChatGPT, Perspectica asks for optional access only to OpenAI's
authentication and inference origins. During article-access onboarding, Perspectica separately
asks for optional permission to read standard websites. Chrome remembers approved grants so the
connection and active-article analysis work after navigation without repeated prompts.
Perspectica does not install a content script that continuously reads every page.

When you request an analysis, Perspectica reads the active article's URL, title, byline, visible
article text, links, publication metadata, and publication date. It sends relevant article text
and research queries to the AI and search providers you selected.

## ChatGPT connection

ChatGPT authorization happens on OpenAI's website. Perspectica never asks for or stores your
OpenAI password.

If **Remember me on this device** is enabled, Perspectica encrypts the refresh token returned by
the device authorization flow and stores it in your Chrome profile. Access tokens are held in
temporary extension session storage. Disconnecting ChatGPT deletes the saved session.

The connection uses a community proof-of-concept library and is not OpenAI's public identity
product.

## Search providers

You can use:

- **Exa**, using an API key that Perspectica encrypts and stores in your Chrome profile; or
- **ChatGPT web search**, when the connected account and selected model support it.

Provider privacy policies and terms apply to data sent to those services.

## Storage and retention

Preferences, bounded analysis events, and encrypted provider credentials are stored locally in
your Chrome profile. Perspectica does not upload this local data to a Perspectica server.

Chrome may preserve extension data across browser restarts and extension updates. Uninstalling the
extension, clearing its site data, or deleting the Chrome profile removes it.

## Data sharing

Perspectica shares data only with the AI and search providers needed to perform the analysis you
requested. Perspectica does not sell data, serve advertising, or perform cross-site tracking.

## Your choices

You can disconnect ChatGPT, replace or stop using Exa, disable remember-me during sign-in, revoke
Perspectica's OpenAI or article site access in Chrome, clear extension data, or uninstall
Perspectica at any time.

## Contact

Use the repository's private security-reporting channel for security or privacy concerns. Do not
include credentials or session material in a public issue.
