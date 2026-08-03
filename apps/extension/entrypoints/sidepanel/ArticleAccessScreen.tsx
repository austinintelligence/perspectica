import { useState } from "react";
import { BrandHeader } from "./BrandHeader";
import { RefreshIcon, ShieldLockIcon, TargetIcon } from "./Icons";

interface ArticleAccessScreenProps {
  onReady: () => void;
  onOpenSettings: () => void;
}

export function ArticleAccessScreen({ onReady, onOpenSettings }: ArticleAccessScreenProps) {
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestAccess = async () => {
    setRequesting(true);
    setError(null);
    try {
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
      if (!granted) {
        throw new Error("Article access was not granted. You can try again when you are ready.");
      }
      onReady();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Chrome could not grant article access.");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="connection-shell atmosphere-page">
      <BrandHeader action="menu" actionLabel="Open preferences" onAction={onOpenSettings} />
      <main className="connection-main">
        <p className="eyebrow">Page access</p>
        <h1 data-route-heading tabIndex={-1}>
          Analyze any article
        </h1>
        <p className="connection-lede">
          Allow Perspectica to read the article you choose to analyze.
        </p>

        <div className="connection-assurances">
          <div>
            <TargetIcon />
            <span>Reads a page only when you start or reopen its report</span>
          </div>
          <div>
            <ShieldLockIcon />
            <span>No background content script watches your browsing</span>
          </div>
          <div>
            <RefreshIcon />
            <span>Chrome remembers this choice and lets you revoke it anytime</span>
          </div>
        </div>

        <button
          type="button"
          className="chatgpt-action connect-button"
          disabled={requesting}
          onClick={() => void requestAccess()}
        >
          {requesting ? "Waiting for Chrome…" : "Allow article access"}
        </button>
        <p className="connection-note">
          Article text is sent only to the AI and search providers you select.
        </p>
        {error ? (
          <p className="connection-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    </div>
  );
}
