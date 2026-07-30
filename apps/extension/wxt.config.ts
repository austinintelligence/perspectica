import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Use the developer's existing Chrome profile instead of launching a
  // separate WXT-managed browser. WXT intentionally keeps live development in
  // `.output/chrome-mv3-dev` and production in `.output/chrome-mv3`: a dev
  // build imports from the local Vite server and must never overwrite the
  // self-contained unpacked production build.
  webExt: {
    disabled: true,
  },
  manifest: {
    name: "Perspectica",
    description: "See the article's political framing, bias signals, and evidence.",
    version: "0.1.0",
    permissions: ["scripting", "storage", "offscreen"],
    // Onboarding requests this optional grant from a direct user gesture.
    // Chrome remembers it so article extraction works after navigation.
    // Extraction remains on demand; no persistent content script is installed.
    optional_host_permissions: ["https://auth.openai.com/*", "https://chatgpt.com/*", "<all_urls>"],
    action: {
      default_title: "Open Perspectica",
      default_icon: {
        16: "icon-16.png",
        32: "icon-32.png",
      },
    },
    icons: {
      16: "icon-16.png",
      32: "icon-32.png",
      48: "icon-48.png",
      128: "icon-128.png",
    },
  },
});
