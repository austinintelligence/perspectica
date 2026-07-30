import { BackgroundController } from "../src/runtime/background-controller";
import { describeError } from "../src/runtime/redaction";

export default defineBackground(() => {
  const controller = new BackgroundController();
  void controller
    .initialize()
    .then(() => controller.resumeActiveJob())
    .catch((error: unknown) => {
      console.error("Perspectica could not initialize its private storage.", describeError(error));
    });

  // Handle the toolbar gesture ourselves so the same action consistently opens
  // the side panel. Page access comes from the remembered optional grant
  // requested during onboarding; extraction still occurs only after a reader
  // starts an analysis.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error: unknown) => {
    console.error("Perspectica could not configure its side panel.", describeError(error));
  });
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    void chrome.sidePanel.open({ tabId: tab.id }).catch((error: unknown) => {
      console.error("Perspectica could not open its side panel.", describeError(error));
    });
  });

  chrome.runtime.onInstalled.addListener(() => {
    void controller.initialize().then(() => controller.resumeActiveJob());
  });
  chrome.runtime.onStartup.addListener(() => {
    void controller.initialize().then(() => controller.resumeActiveJob());
  });
  chrome.runtime.onConnect.addListener((port) => controller.onConnect(port));
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    controller.onMessage(message, sender, sendResponse),
  );
});
