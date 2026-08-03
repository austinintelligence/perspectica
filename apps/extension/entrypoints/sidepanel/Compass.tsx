import { useId, useState } from "react";
import type { CompassResult } from "@perspectica/contracts";
import { TargetIcon } from "./Icons";

interface CompassProps {
  result: CompassResult;
}

function percent(value: number): number {
  return ((value + 3) / 6) * 100;
}

const basisLabels: Record<CompassResult["basis"], string> = {
  "article-led": "Article-led",
  "context-assisted": "Context-assisted",
  "context-led": "Context-led",
  "calibrated-fallback": "Calibrated estimate",
  insufficient: "Research exhausted",
};

const spectrumStops = [
  "Far left",
  "Left",
  "Center-left",
  "Center",
  "Center-right",
  "Right",
  "Far right",
] as const;

export function Compass({ result }: CompassProps) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const summaryId = useId();

  return (
    <div className="compass-disclosure">
      <button
        className="compass-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        aria-describedby={summaryId}
        aria-label={`${open ? "Hide" : "Show"} political spectrum details`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="compass-toggle-icon" aria-hidden="true">
          <TargetIcon />
        </span>
        <span className="compass-toggle-copy">
          <small>Political Spectrum</small>
          <strong>{result.displayLabel}</strong>
        </span>
        <span className="toggle-mark" aria-hidden="true" />
        <span id={summaryId} className="sr-only">
          {open ? "Details are open." : "Details are closed."} Activate to {open ? "hide" : "show"}{" "}
          the spectrum.
        </span>
      </button>

      {open ? (
        <div className="compass-detail-motion" id={contentId}>
          <div className="compass-detail">
            {result.score !== null ? (
              <div className="spectrum-figure">
                <div className="spectrum-track" aria-hidden="true">
                  {spectrumStops.map((stop, index) => (
                    <span
                      className={`spectrum-tick${index === 3 ? " spectrum-tick-center" : ""}`}
                      key={stop}
                      style={{ left: `${(index / 6) * 100}%` }}
                    />
                  ))}
                </div>
                <span className="spectrum-end spectrum-end-left">Far left</span>
                <span className="spectrum-end spectrum-end-center">Center</span>
                <span className="spectrum-end spectrum-end-right">Far right</span>
                <button
                  className="spectrum-point"
                  type="button"
                  aria-label={`${result.displayLabel}. Spectrum score ${result.score}.`}
                  style={{
                    left: `${percent(result.score)}%`,
                  }}
                >
                  <span className="point-tooltip">
                    {result.displayLabel}
                    <small>
                      {result.score > 0 ? "+" : ""}
                      {result.score.toFixed(2)}
                    </small>
                  </span>
                </button>
              </div>
            ) : (
              <p className="empty-copy">{result.explanation}</p>
            )}

            {result.score !== null ? <p>{result.explanation}</p> : null}
            <p className="confidence">
              {result.score !== null
                ? `${result.confidence} confidence · ${Math.round(result.confidenceScore * 100)}%`
                : "No reliable placement"}
            </p>
            <p className="compass-basis">Basis · {basisLabels[result.basis]}</p>
            {result.evidence.length > 0 ? (
              <div className="evidence-list">
                <h3>{result.score !== null ? "Placement evidence" : "Signals considered"}</h3>
                {result.evidence.map((evidence) => (
                  <blockquote key={evidence.id}>
                    “{evidence.excerpt}”<footer>{evidence.explanation}</footer>
                  </blockquote>
                ))}
              </div>
            ) : null}
            {result.context.signals.length > 0 ? (
              <div className="evidence-list context-evidence-list">
                <h3>Publication and journalist context</h3>
                {result.context.signals.map((signal) => (
                  <p key={signal.id} className="context-signal">
                    {signal.explanation}{" "}
                    <a href={signal.url} target="_blank" rel="noreferrer">
                      {signal.publication}
                    </a>
                    {signal.citationKind === "search-summary" ? (
                      <small className="search-summary-label">Web-search summary</small>
                    ) : null}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
