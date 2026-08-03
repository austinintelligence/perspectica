# Data retention and deletion

Perspectica does not run a server that retains reader data. Local data remains in the browser
profile until it expires, the reader removes it, or the browser clears it.

| Data                                  | Location                       | Retention                                                                                   | Deletion                                                        |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Preferences                           | Chrome extension local storage | Until cleared, uninstalled, or replaced by normal storage migration                         | Use extension/browser reset controls.                           |
| Encrypted recent runs and diagnostics | Local IndexedDB vault          | Ten runs or seven days, whichever comes first; 25 MB total cap                              | Clear selected/all runs in Diagnostics or clear extension data. |
| Active access tokens                  | `chrome.storage.session`       | Browser session or until disconnect/expiry                                                  | Disconnect ChatGPT or close/clear the browser session.          |
| Remembered ChatGPT refresh token      | Encrypted local vault          | Until disconnect, remember-me is disabled, extension data is cleared, or profile is deleted | Disconnect ChatGPT, then clear data for a complete reset.       |
| Exa API key                           | Encrypted local vault          | Until replaced, removed, extension data is cleared, or profile is deleted                   | Remove the key in Settings, then clear data if needed.          |
| Active journal and retry artifacts    | Local IndexedDB                | Bounded to the active/recent compatible run and removed on terminal expiry                  | Cancel/discard the run or clear extension data.                 |

Provider-side retention is controlled by each selected provider's terms and privacy policy. A
reader who needs provider-side deletion must use that provider's controls.

A full support export may contain article excerpts, prompts, searches, and model output. The UI
warns before copying and redacts credentials, bearer tokens, cookies, API keys, signed URLs, and
authentication parameters. Exported logs and screenshots are outside the extension's deletion
controls and should be treated as user-owned copies.
