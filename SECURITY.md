# Security policy

Perspectica is a proof-of-concept Chrome extension. Its zero-hosted design removes a central
credential store, but it does not remove the risks of storing provider credentials on a device.

## Supported configuration

- Install only builds produced from this repository or a trusted Chrome Web Store listing.
- Keep Chrome and the extension updated.
- Use a Chrome profile protected by the operating system account.
- Disconnect ChatGPT and clear the Exa key before sharing a profile or device.
- Do not sideload modified builds from untrusted sources.

## Credential handling

When **Remember me on this device** is selected, Perspectica stores an encrypted ChatGPT refresh
token in `chrome.storage.local`. An AES-256-GCM key is generated as a non-exportable Web Crypto
key and kept in IndexedDB. Access tokens remain in `chrome.storage.session`. Exa keys use a
separate encrypted vault record.

This protects credentials from casual storage inspection. It is not a hardware-backed secret
store and cannot protect an unlocked, compromised browser profile or malicious software running
as the user.

Extension storage access is restricted to trusted extension contexts. The extension never places
credentials in UI messages, logs, analysis events, or article-page scripts.

## Network and page-access boundaries

The production manifest declares two narrow OpenAI origins and `<all_urls>` as optional host
permissions. Choosing **Login with ChatGPT** requests only the OpenAI origins from that direct user
gesture. During article-access onboarding, Perspectica separately explains and requests
`<all_urls>`. Chrome remembers approved grants until the reader revokes them or clears extension
data.

Perspectica does not register a persistent content script. The packaged extractor is injected
only into the active tab after the user starts an analysis. Protected browser pages such as
`chrome://` remain inaccessible, and no remote executable code is loaded.

## Reporting a vulnerability

Do not publish suspected vulnerabilities, credentials, session material, or working exploit
details in a public issue. Use GitHub private vulnerability reporting when enabled; otherwise
contact the repository owner through their GitHub profile.

Include the affected version, browser version, reproduction steps, expected impact, and any
mitigation you identified.

## Experimental authentication notice

The ChatGPT device flow comes from the community `login-with-chatgpt` project. It is not OpenAI's
public Sign in with ChatGPT identity product. Provider behavior or policy may change and require a
new extension release.
