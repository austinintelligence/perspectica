import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AnalysisModel, AnalysisPreferences, ResearchDepth } from "@perspectica/contracts";
import type { AnalysisMode } from "@perspectica/contracts/preferences";
import type { SearchProviderKind } from "../../src/runtime/messages";
import { BrandHeader } from "./BrandHeader";
import { ChevronDownIcon } from "./Icons";
import { ResearchDepthControl } from "./DepthControl";
import {
  ANALYSIS_MODELS,
  REASONING_EFFORTS,
  recommendedInferenceForDepth,
  usesCustomInference,
} from "./preferences";
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
  researchDepth?: ResearchDepth;
  onResearchDepthChange?: (depth: ResearchDepth) => Promise<void> | void;
  onOpenDiagnostics?: () => void;
  onOpenAbout?: () => void;
  analysisLocked?: boolean;
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
  researchDepth = "balanced" as ResearchDepth,
  onResearchDepthChange,
  onOpenDiagnostics,
  onOpenAbout,
  analysisLocked = false,
}: SettingsScreenProps) {
  type SettingsTab = "analysis" | "sources" | "account";
  const tabs: ReadonlyArray<{ id: SettingsTab; label: string }> = [
    { id: "analysis", label: "Analysis" },
    { id: "sources", label: "Sources" },
    { id: "account", label: "Account" },
  ];
  const [disconnecting, setDisconnecting] = useState(false);
  const [exaKey, setExaKey] = useState("");
  const [providerStatus, setProviderStatus] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [activeTab, setActiveTab] = useState<SettingsTab>("analysis");
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const titleId = useId();
  const descriptionId = useId();
  const selectedModel = ANALYSIS_MODELS.find((model) => model.value === preferences.model);
  const customInference = usesCustomInference(researchDepth, preferences);
  const selectableModels = ANALYSIS_MODELS.filter(
    (model) => availableModels.length === 0 || availableModels.includes(model.value),
  );
  if (!selectableModels.some((model) => model.value === preferences.model) && selectedModel) {
    selectableModels.unshift(selectedModel);
  }

  const disconnect = async () => {
    if (!window.confirm("Disconnect ChatGPT and remove the remembered session from this device?")) {
      return;
    }
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
    void Promise.resolve()
      .then(() => onChange(next))
      .then(
        () => setSaveStatus("saved"),
        () => setSaveStatus("error"),
      );
  };

  const selectDepth = (depth: ResearchDepth) => {
    if (onResearchDepthChange) {
      setSaveStatus("saving");
      void Promise.resolve()
        .then(() => onResearchDepthChange(depth))
        .then(
          () => setSaveStatus("saved"),
          () => setSaveStatus("error"),
        );
    } else {
      savePreferences({
        ...preferences,
        ...recommendedInferenceForDepth(depth),
        mode: depth as AnalysisMode,
        depth,
      });
    }
  };

  const moveTab = (current: SettingsTab, direction: 1 | -1 | "first" | "last") => {
    const index = tabs.findIndex((tab) => tab.id === current);
    const nextIndex =
      direction === "first"
        ? 0
        : direction === "last"
          ? tabs.length - 1
          : (index + direction + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    setActiveTab(next.id);
    requestAnimationFrame(() => tabRefs.current[next.id]?.focus());
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: SettingsTab) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveTab(current, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveTab(current, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTab(current, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      moveTab(current, "last");
    }
  };

  return (
    <div className="settings-layer atmosphere-page">
      <BrandHeader action="close" actionLabel="Close settings" onAction={onClose} />
      <main className="settings-main" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="settings-intro">
          <p className="eyebrow">Preferences</p>
          <h1 id={titleId} data-route-heading tabIndex={-1}>
            Settings
          </h1>
          <p id={descriptionId}>Choose how Perspectica analyzes articles.</p>
        </header>

        <div
          className="settings-tabs"
          role="tablist"
          aria-label="Settings categories"
          aria-orientation="horizontal"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tab.id] = element;
              }}
              id={`${tab.id}-tab`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`${tab.id}-panel`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={activeTab === tab.id ? "selected" : undefined}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          id="analysis-panel"
          role="tabpanel"
          aria-labelledby="analysis-tab"
          tabIndex={0}
          hidden={activeTab !== "analysis"}
        >
          <ResearchDepthControl
            depth={researchDepth}
            onChange={selectDepth}
            id="settings-research-depth"
            disabled={analysisLocked}
          />
          {analysisLocked ? (
            <p className="preference-help settings-lock-note" role="status">
              Finish or stop the current analysis before changing its research settings.
            </p>
          ) : null}
          <details className="advanced-settings-disclosure">
            <summary>
              Advanced model settings
              {customInference ? <span className="settings-custom-label">Custom</span> : null}
            </summary>
            <section className="preference-section">
              <label className="preference-label" htmlFor="analysis-model">
                Analysis model
              </label>
              <div className="select-wrap">
                <select
                  id="analysis-model"
                  value={preferences.model}
                  disabled={analysisLocked}
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
            <section className="preference-section">
              <span className="preference-label" id="reasoning-label">
                Reasoning effort
              </span>
              <div className="reasoning-control" role="group" aria-labelledby="reasoning-label">
                {REASONING_EFFORTS.map((effort) => (
                  <button
                    type="button"
                    disabled={analysisLocked}
                    aria-pressed={preferences.reasoningEffort === effort.value}
                    className={
                      preferences.reasoningEffort === effort.value ? "selected" : undefined
                    }
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
          </details>
        </div>

        <p className="settings-saved" role="status" aria-live="polite">
          {saveStatus === "saving"
            ? "Saving changes…"
            : saveStatus === "saved"
              ? "Changes saved."
              : saveStatus === "error"
                ? "Could not save changes. Your previous settings were restored."
                : "Changes save automatically."}
        </p>

        <div
          id="sources-panel"
          role="tabpanel"
          aria-labelledby="sources-tab"
          tabIndex={0}
          hidden={activeTab !== "sources"}
        >
          <section className="preference-section">
            <span className="preference-label">Public research cache</span>
            <p className="preference-help">
              Cached public evidence never contains ChatGPT credentials or your article identity.
            </p>
            <button
              type="button"
              disabled={analysisLocked}
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

          {searchProvider && onSearchProviderChange ? (
            <section className="preference-section">
              <span className="preference-label">Web research</span>
              <div className="reasoning-control" role="group" aria-label="Search provider">
                {["free", "chatgpt", "exa"].map((provider) => (
                  <button
                    type="button"
                    disabled={analysisLocked}
                    aria-pressed={searchProvider === provider}
                    className={searchProvider === provider ? "selected" : undefined}
                    onClick={() => {
                      setProviderStatus(
                        `Testing ${provider === "exa" ? "Exa" : provider === "chatgpt" ? "ChatGPT" : "free research"}…`,
                      );
                      void onSearchProviderChange(provider as SearchProviderKind).then(
                        () =>
                          setProviderStatus(
                            provider === "exa"
                              ? "Exa connected"
                              : provider === "chatgpt"
                                ? "ChatGPT search connected"
                                : "Free research ready",
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
                    {provider === "exa" ? "Exa" : provider === "chatgpt" ? "ChatGPT" : "Free"}
                  </button>
                ))}
              </div>
              {searchProvider === "exa" ? (
                <div className="settings-provider-key">
                  <label className="sr-only" htmlFor="exa-api-key">
                    Exa API key
                  </label>
                  <input
                    id="exa-api-key"
                    type="password"
                    disabled={analysisLocked}
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
                    disabled={analysisLocked || !exaKey.trim()}
                  >
                    Save and test
                  </button>
                  {hasExaKey ? (
                    <button
                      type="button"
                      className="provider-remove-key"
                      disabled={analysisLocked}
                      onClick={() => {
                        if (!window.confirm("Remove the saved Exa API key from this device?"))
                          return;
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
              <p className="preference-help" role="status" aria-live="polite">
                {providerStatus ??
                  (searchProvider === "exa"
                    ? hasExaKey
                      ? "An encrypted Exa key is saved on this device."
                      : "Add an Exa key before the next analysis."
                    : searchProvider === "chatgpt"
                      ? "Native search is checked against your connected ChatGPT account."
                      : "Uses bounded public discovery. No API key is required.")}
              </p>
            </section>
          ) : null}
        </div>

        <div
          id="account-panel"
          role="tabpanel"
          aria-labelledby="account-tab"
          tabIndex={0}
          hidden={activeTab !== "account"}
        >
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
                disabled={disconnecting || analysisLocked}
                onClick={() => void disconnect()}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect ChatGPT"}
              </button>
            ) : null}
          </section>

          <nav className="settings-secondary-nav" aria-label="More Perspectica screens">
            {onOpenDiagnostics ? (
              <button type="button" onClick={onOpenDiagnostics}>
                Diagnostics
              </button>
            ) : null}
            {onOpenAbout ? (
              <button type="button" onClick={onOpenAbout}>
                About
              </button>
            ) : null}
          </nav>
        </div>
      </main>
    </div>
  );
}
