# Browser support

The supported target is a current Chromium browser with Manifest V3 Side Panel, Offscreen,
optional host-permission, and `chrome.scripting` APIs.

| Browser          | Support posture           | Notes                                                                                                                                                 |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Chrome    | Primary target            | Use the Chrome Web Store build or the verified GitHub helper/unpacked directory for development.                                                      |
| Microsoft Edge   | Supported Chromium target | Use **Load unpacked** from the fixed developer directory; smoke-test Side Panel, Offscreen, permissions, and provider prompts on the release channel. |
| Brave            | Supported Chromium target | Use the same fixed developer directory; Shields, account policy, or provider access can change behavior.                                              |
| Firefox / Safari | Not supported             | The MV3 Side Panel and Offscreen APIs are not part of the supported test matrix.                                                                      |

Keep the browser current and test a release in a fresh profile before publishing. Corporate
browser policies, disabled side panels, blocked third-party provider origins, or an unavailable
ChatGPT model may prevent a report; the extension must surface that limitation rather than
requesting broader permissions.

## Latest local smoke test

On August 3, 2026, the production unpacked package loaded successfully in fresh local Google Chrome
and Brave profiles. The side panel rendered without horizontal overflow at 320, 360, 420, and 520
CSS pixels. Microsoft Edge was not installed on the reference machine, so its release-channel smoke
test remains required before publishing.
