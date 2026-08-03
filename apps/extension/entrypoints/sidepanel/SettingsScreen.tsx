import { useEffect, useId, useRef, useState } from "react";
import type { AnalysisModel, AnalysisPreferences } from "@perspectica/contracts";
import type { AnalysisMode } from "@perspectica/contracts/preferences";
import type { SearchProviderKind } from "../../src/runtime/messages";
import { BrandHeader } from "./BrandHeader";
import { ChevronDownIcon } from "./Icons";
import { ANALYSIS_MODELS, REASONING_EFFORTS } from "./preferences";
import {
  clearExaApiKey,
  clearResearchCache,
  saveExaApiKey,
  testExaApiKey,
  testSearchProvider,
} from "./api";

export type SettingsPreferences = AnalysisPreferences & { mode: AnalysisMode };

interface SettingsScreenProps {
  authenticated: boolean;
  preferences: SettingsPreferences;
  onChange: (preferences: SettingsPreferences) => Promise<void> | void;
  onClose: () => void;
  onDisconnect: () => Promise<void>;
  availableModels?: string[];
  searchProvider?: SearchProviderKind;
  hasExaKey?: boolean;
  onSearchProviderChange?: (provider: SearchProviderKind) => Promise<void>;
  onExaKeySaved?: () => void;
  onExaKeyRemoved?: () => void;
}

export function SettingsScreen({
  authenticated,
  preferences,
  onChange,
  onClose,
  onDisconnect,
  availableModels = [],
  searchProvider,
  hasExaKey = false,
  onSearchProviderChange,
  onExaKeySaved,
  onExaKeyRemoved,
}: SettingsScreenProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [exaKey, setExaKey] = useState("");
  const [providerStatus, setProviderStatus] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return undefined;

    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("aria-hidden"));

    const first = focusable()[0];
    queueMicrotask(() => (first ?? dialog).focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const current = document.activeElement;
      const index = elements.indexOf(current as HTMLElement);
      const next = event.shiftKey
        ? elements[(index <= 0 ? elements.length : index) - 1]
        : elements[(index + 1) % elements.length];
      if (
        index === -1 ||
        (!event.shiftKey && index === elements.length - 1) ||
        (event.shiftKey && index === 0)
      ) {
        event.preventDefault();
        next?.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);
  const selectedModel = ANALYSIS_MODELS.find((model) => model.value === preferences.model);
  const selectableModels = ANALYSIS_MODELS.filter(
    (model) => availableModels.length === 0 || availableModels.includes(model.value),
  );
  if (!selectableModels.some((model) => model.value === preferences.model) && selectedModel) {
    selectableModels.unshift(selectedModel);
  }

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
      onClose();
    } finally {
      setDisconnecting(false);
    }
  };

  const savePreferences = (next: SettingsPreferences) => {
    setSaveStatus("saving");
    void Promise.resolve(onChange(next)).then(
      () => setSaveStatus("saved"),
      () => setSaveStatus("error"),
    );
  };

  return (
    <div
      ref={dialogRef}
      className="settings-layer atmosphere-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <BrandHeader action="close" actionLabel="Close settings" onAction={onClose} />
      <main className="settings-main">
        <header className="settings-intro">
          <p className="eyebrow">Preferences</p>
          <h1 id={titleId}>Settings</h1>
          <p>Choose how Perspectica analyzes articles.</p>
        </header>

        <section className="preference-section">
          <span className="preference-label" id="analysis-mode-label">
            Analysis depth
          </span>
          <div className="reasoning-control" role="group" aria-labelledby="analysis-mode-label">
            {(
              [
                ["fast", "Fast"],
                ["balanced", "Balanced"],
                ["deep", "Deep"],
              ] as const
            ).map(([mode, label]) => (
              <button
                type="button"
                aria-pressed={preferences.mode === mode}
                className={preferences.mode === mode ? "selected" : undefined}
                onClick={() => savePreferences({ ...preferences, mode })}
                key={mode}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="preference-help">
            {preferences.mode === "fast"
              ? "Fast uses the smallest context and mission budget."
              : preferences.mode === "deep"
                ? "Deep allows more context and evidence checks."
                : "Balanced is the default tradeoff between speed and depth."}
          </p>
        </section>

        <section className="preference-section">
          <span className="preference-label">Public research cache</span>
          <p className="preference-help">
            Cached public evidence never contains ChatGPT credentials or your article identity.
          </p>
          <button
            type="button"
            onClick={() => {
              setCacheStatus("Clearing cache…");
              void clearResearchCache().then(
                () => setCacheStatus("Research cache cleared"),
                () => setCacheStatus("Could not clear research cache"),
              );
            }}
          >
            Clear research cache
          </button>
          {cacheStatus ? <small className="preference-help">{cacheStatus}</small> : null}
        </section>

        <section className="preference-section">
          <label className="preference-label" htmlFor="analysis-model">
            Analysis model
          </label>
          <div className="select-wrap">
            <select
              id="analysis-model"
              value={preferences.model}
              onChange={(event) =>
                savePreferences({
                  ...preferences,
                  model: event.target.value as AnalysisModel,
                })
              }
            >
              {selectableModels.map((model) => (
                <option value={model.value} key={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
            <ChevronDownIcon />
          </div>
          <p className="preference-help">{selectedModel?.description}</p>
        </section>

        {searchProvider && onSearchProviderChange ? (
          <section className="preference-section">
            <span className="preference-label">Web research</span>
            <div className="reasoning-control" role="group" aria-label="Search provider">
              {(["exa", "chatgpt"] as const).map((provider) => (
                <button
                  type="button"
                  aria-pressed={searchProvider === provider}
                  className={searchProvider === provider ? "selected" : undefined}
                  onClick={() => {
                    setProviderStatus(`Testing ${provider === "exa" ? "Exa" : "ChatGPT"}…`);
                    void onSearchProviderChange(provider).then(
                      () =>
                        setProviderStatus(
                          provider === "exa" ? "Exa connected" : "ChatGPT search connected",
                        ),
                      (cause: unknown) =>
                        setProviderStatus(
                          cause instanceof Error
                            ? cause.message
                            : "The search provider could not connect.",
                        ),
                    );
                  }}
                  key={provider}
                >
                  {provider === "exa" ? "Exa" : "ChatGPT"}
                </button>
              ))}
            </div>
            {searchProvider === "exa" ? (
              <div className="settings-provider-key">
                <input
                  type="password"
                  value={exaKey}
                  autoComplete="off"
                  placeholder={hasExaKey ? "Replace saved Exa key" : "Enter Exa API key"}
                  onChange={(event) => setExaKey(event.target.value)}
                />
                <button
                  type="button"
                  onClick={() => {
                    setProviderStatus("Testing…");
                    void testExaApiKey(exaKey.trim())
                      .then(() => saveExaApiKey(exaKey.trim()))
                      .then(() => {
                        setExaKey("");
                        setProviderStatus("Exa connected");
                        onExaKeySaved?.();
                      })
                      .catch((cause: unknown) =>
                        setProviderStatus(
                          cause instanceof Error ? cause.message : "Exa could not connect.",
                        ),
                      );
                  }}
                  disabled={!exaKey.trim()}
                >
                  Save and test
                </button>
                {hasExaKey ? (
                  <button
                    type="button"
                    className="provider-remove-key"
                    onClick={() => {
                      setProviderStatus("Removing key…");
                      void clearExaApiKey().then(
                        () => {
                          setProviderStatus("Exa key removed");
                          setExaKey("");
                          onExaKeyRemoved?.();
                        },
                        (cause: unknown) =>
                          setProviderStatus(
                            cause instanceof Error
                              ? cause.message
                              : "The Exa key could not be removed.",
                          ),
                      );
                    }}
                  >
                    Remove key
                  </button>
                ) : null}
              </div>
            ) : null}
            <p className="preference-help">
              {providerStatus ??
                (searchProvider === "exa"
                  ? hasExaKey
                    ? "An encrypted Exa key is saved on this device."
                    : "Add an Exa key before the next analysis."
                  : "Native search is checked against your connected ChatGPT account.")}
            </p>
          </section>
        ) : null}

        <section className="preference-section">
          <span className="preference-label" id="reasoning-label">
            Reasoning effort
          </span>
          <div className="reasoning-control" role="group" aria-labelledby="reasoning-label">
            {REASONING_EFFORTS.map((effort) => (
              <button
                type="button"
                aria-pressed={preferences.reasoningEffort === effort.value}
                className={preferences.reasoningEffort === effort.value ? "selected" : undefined}
                onClick={() =>
                  savePreferences({
                    ...preferences,
                    reasoningEffort: effort.value,
                  })
                }
                key={effort.value}
              >
                {effort.label}
              </button>
            ))}
          </div>
          <p className="preference-help">
            {preferences.reasoningEffort === "low"
              ? "Low prioritizes speed."
              : preferences.reasoningEffort === "high"
                ? "High prioritizes depth."
                : "Medium balances speed and depth."}
          </p>
        </section>

        <section className="preference-section account-section">
          <h2 className="preference-label">ChatGPT account</h2>
          <p className="connection-status">
            <span className={authenticated ? "connected-dot" : "disconnected-dot"} />
            {authenticated ? "Connected to ChatGPT" : "Not connected"}
          </p>
          <p className="preference-help">
            {authenticated
              ? "Your session is stored on this device."
              : "Close settings to connect your account."}
          </p>
          {authenticated ? (
            <button
              className="disconnect-button"
              type="button"
              disabled={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting ? "Disconnecting…" : "Disconnect ChatGPT"}
            </button>
          ) : null}
        </section>

        <p className="settings-saved" role="status" aria-live="polite">
          {saveStatus === "saving"
            ? "Saving changes…"
            : saveStatus === "saved"
              ? "Changes saved."
              : saveStatus === "error"
                ? "Could not save changes. Your previous settings were restored."
                : "Changes save automatically."}
        </p>
      </main>
    </div>
  );
}
