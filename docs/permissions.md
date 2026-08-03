# Permission justifications

The production Manifest V3 build requests the smallest permissions needed for its local,
user-initiated workflow. Review this page alongside the generated `manifest.json` before every
store submission.

| Manifest entry                         | Why it is needed                                                                                                                       | User control and boundary                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripting`                            | Injects the packaged article extractor into the active tab after the reader starts an analysis.                                        | No persistent content script; protected browser pages remain inaccessible.                                                                                                     |
| `storage`                              | Stores preferences, bounded report state, and the encrypted credential envelope in the current extension profile.                      | Clearing extension data or uninstalling removes local data; secrets never enter page scripts or UI messages.                                                                   |
| `offscreen`                            | Runs the bounded analysis pipeline outside the MV3 service worker so suspension does not interrupt a report.                           | The offscreen document is packaged code and is created only for an active run.                                                                                                 |
| `https://auth.openai.com/*` (optional) | Opens the user-directed device authorization page.                                                                                     | Requested only from **Login with ChatGPT** and can be revoked in Chrome settings.                                                                                              |
| `https://chatgpt.com/*` (optional)     | Exchanges the connected session and performs provider calls supported by the selected account/model.                                   | Requested with the login flow; Perspectica does not automate the ChatGPT website UI.                                                                                           |
| `<all_urls>` (optional)                | Reads the active article on any ordinary website and bounded public source pages because publication domains are not known in advance. | Requested separately during article-access onboarding, after explanation and a direct user gesture; only the active tab and validated public HTTPS sources are read on demand. |

There are no required host permissions, no `content_scripts` entry, no localhost origin, and no
remote executable scripts. A change to this table, the manifest, or the permission request flow
requires a privacy review and an update to the Chrome Web Store disclosure.
