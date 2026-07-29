import { ExtractionRequestMessageSchema } from "@perspectica/contracts";
import { extractArticleDocument } from "@perspectica/extraction";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const parsed = ExtractionRequestMessageSchema.safeParse(message);
      if (!parsed.success) return false;

      try {
        sendResponse({
          ok: true,
          article: extractArticleDocument(document, window.location.href),
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Perspectica could not read this page.",
        });
      }
      return false;
    });
  },
});
