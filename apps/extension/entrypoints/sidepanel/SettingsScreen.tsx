import { useState } from "react";
import { m, useReducedMotion } from "motion/react";
import type { AnalysisModel, AnalysisPreferences } from "@perspectica/contracts";
import { BrandHeader } from "./BrandHeader";
import { ChevronDownIcon } from "./Icons";
import { ANALYSIS_MODELS, REASONING_EFFORTS } from "./preferences";

interface SettingsScreenProps {
  authenticated: boolean;
  preferences: AnalysisPreferences;
  onChange: (preferences: AnalysisPreferences) => void;
  onClose: () => void;
  onDisconnect: () => Promise<void>;
}

export function SettingsScreen({
  authenticated,
  preferences,
  onChange,
  onClose,
  onDisconnect,
}: SettingsScreenProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const reduceMotion = useReducedMotion();
  const selectedModel = ANALYSIS_MODELS.find((model) => model.value === preferences.model);

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
      onClose();
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <m.div
      className="settings-layer atmosphere-page"
      role="dialog"
      aria-modal="true"
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: 8 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
    >
      <BrandHeader action="close" actionLabel="Close settings" onAction={onClose} />
      <main className="settings-main">
        <header className="settings-intro">
          <p className="eyebrow">Preferences</p>
          <h1>Settings</h1>
          <p>Choose how Perspectica analyzes articles.</p>
        </header>

        <section className="preference-section">
          <label className="preference-label" htmlFor="analysis-model">
            Analysis model
          </label>
          <div className="select-wrap">
            <select
              id="analysis-model"
              value={preferences.model}
              onChange={(event) =>
                onChange({
                  ...preferences,
                  model: event.target.value as AnalysisModel,
                })
              }
            >
              {ANALYSIS_MODELS.map((model) => (
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
                aria-pressed={preferences.reasoningEffort === effort.value}
                className={preferences.reasoningEffort === effort.value ? "selected" : undefined}
                onClick={() =>
                  onChange({
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

        <p className="settings-saved">Changes are saved automatically.</p>
      </main>
    </m.div>
  );
}
