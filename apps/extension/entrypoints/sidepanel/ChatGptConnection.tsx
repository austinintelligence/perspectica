import {
  useLoginWithChatGPT,
  type UseLoginWithChatGPTResult,
} from "@opencoredev/loginwithchatgpt-react";
import { useState } from "react";
import { authenticatedApiFetch, chatGptAuthBaseUrl } from "./api";
import { BrandHeader } from "./BrandHeader";
import { OpenAiBlossomIcon, RefreshIcon, ShieldLockIcon, TargetIcon } from "./Icons";

const POPUP_FEATURES = "popup=yes,width=520,height=680,menubar=no,toolbar=no,location=yes";

export function usePerspecticaChatGpt(): UseLoginWithChatGPTResult {
  return useLoginWithChatGPT({
    basePath: chatGptAuthBaseUrl,
    fetch: authenticatedApiFetch,
    pollIntervalMs: 2_500,
    openPopup: true,
    autoCopyCode: true,
  });
}

interface ChatGptConnectionScreenProps {
  connection: UseLoginWithChatGPTResult;
  onOpenSettings: () => void;
}

export function ChatGptConnectionScreen({
  connection,
  onOpenSettings,
}: ChatGptConnectionScreenProps) {
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);

  const startLogin = () => {
    const popup = window.open("about:blank", "login-with-chatgpt", POPUP_FEATURES);
    void connection.login({ popup });
  };

  return (
    <div className="connection-shell atmosphere-page">
      <BrandHeader action="menu" actionLabel="Open preferences" onAction={onOpenSettings} />

      <main className="connection-main">
        <p className="eyebrow">Analysis provider</p>
        <h1>Connect ChatGPT</h1>
        <p className="connection-lede">Use your ChatGPT plan to analyze the articles you read.</p>

        <div className="connection-assurances">
          <div>
            <TargetIcon />
            <span>Runs through your local Perspectica API</span>
          </div>
          <div>
            <ShieldLockIcon />
            <span>Session saved securely on this device</span>
          </div>
          <div>
            <RefreshIcon />
            <span>Disconnect whenever you want</span>
          </div>
        </div>

        {connection.status === "loading" ? (
          <p className="connection-state">Checking your saved connection…</p>
        ) : null}

        {connection.isPending ? (
          <div className="device-flow" aria-live="polite">
            <p className="connection-state">Finish signing in with OpenAI.</p>
            <span className="device-label">Your one-time code</span>
            <strong className="device-code">{connection.userCode}</strong>
            <div className="connection-actions">
              <button type="button" className="chatgpt-action" onClick={connection.reopen}>
                <OpenAiBlossomIcon />
                Continue sign-in
              </button>
              <button
                type="button"
                className="text-action"
                onClick={() => void connection.copyCode()}
              >
                {connection.copied ? "Copied" : "Copy code"}
              </button>
            </div>
          </div>
        ) : null}

        {connection.status !== "loading" && !connection.isPending ? (
          <button
            type="button"
            className="chatgpt-action connect-button"
            onClick={startLogin}
            disabled={connection.isConnecting}
          >
            <OpenAiBlossomIcon />
            {connection.isConnecting ? "Starting secure sign-in…" : "Login with ChatGPT"}
          </button>
        ) : null}

        {connection.error ? (
          <p className="connection-error" role="alert">
            {connection.error}
          </p>
        ) : null}

        <button
          type="button"
          className="connection-help"
          aria-expanded={showConnectionDetails}
          onClick={() => setShowConnectionDetails((current) => !current)}
        >
          How your connection is used
        </button>
        {showConnectionDetails ? (
          <p className="connection-note">
            Extracted article text and analysis prompts pass through the local Perspectica API. Your
            refreshable session is encrypted on this computer, and each analysis counts toward your
            ChatGPT and Codex plan usage.
          </p>
        ) : null}
      </main>
    </div>
  );
}
