import { useState } from "react";
import type { ExtensionPreferences, SearchProviderKind } from "../../src/runtime/messages";
import { saveExaApiKey, testExaApiKey, testSearchProvider } from "./api";
import { BrandHeader } from "./BrandHeader";

interface SearchSetupScreenProps {
  preferences: ExtensionPreferences;
  onChange: (preferences: ExtensionPreferences) => Promise<void>;
  onReady: () => void;
  onOpenSettings: () => void;
}

export function SearchSetupScreen({
  preferences,
  onChange,
  onReady,
  onOpenSettings,
}: SearchSetupScreenProps) {
  const [provider, setProvider] = useState<SearchProviderKind>(preferences.searchProvider);
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const continueSetup = async () => {
    setTesting(true);
    setError(null);
    try {
      if (provider === "exa") {
        if (!apiKey.trim()) throw new Error("Enter your Exa API key.");
        await testExaApiKey(apiKey.trim());
        await saveExaApiKey(apiKey.trim());
      }
      const test =
        provider === "exa" ? { available: true as const } : await testSearchProvider(provider);
      if (!test.available) {
        throw new Error(
          provider === "chatgpt"
            ? "Native ChatGPT search is not available for this account. Choose Exa."
            : "Exa did not confirm the connection.",
        );
      }
      await onChange({ ...preferences, searchProvider: provider });
      onReady();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The search provider could not connect.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="connection-shell atmosphere-page">
      <BrandHeader action="menu" actionLabel="Open preferences" onAction={onOpenSettings} />
      <main className="connection-main search-setup-main">
        <p className="eyebrow">Research provider</p>
        <h1>Choose web search</h1>
        <p className="connection-lede">
          Perspectica uses outside sources to check and contextualize the article.
        </p>

        <div className="provider-options" role="radiogroup" aria-label="Search provider">
          <button
            type="button"
            role="radio"
            aria-checked={provider === "exa"}
            className={provider === "exa" ? "selected" : undefined}
            onClick={() => setProvider("exa")}
          >
            <strong>Exa</strong>
            <span>Fast, focused research using your own Exa API key.</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={provider === "chatgpt"}
            className={provider === "chatgpt" ? "selected" : undefined}
            onClick={() => setProvider("chatgpt")}
          >
            <strong>ChatGPT search</strong>
            <span>Uses hosted search when your connected account supports it.</span>
          </button>
        </div>

        {provider === "exa" ? (
          <label className="provider-key-field">
            <span>Exa API key</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your Exa key"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>The key is encrypted and saved only in this Chrome profile.</small>
          </label>
        ) : null}

        <button
          type="button"
          className="chatgpt-action connect-button"
          disabled={testing}
          onClick={() => void continueSetup()}
        >
          {testing ? "Testing connection…" : "Save and continue"}
        </button>
        {error ? (
          <p className="connection-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    </div>
  );
}
