import type { ResearchDepth } from "@perspectica/contracts";

export const RESEARCH_DEPTH_OPTIONS: ReadonlyArray<{
  value: ResearchDepth;
  label: string;
  detail: string;
}> = [
  { value: "quick" as ResearchDepth, label: "Quick", detail: "A fast orientation pass." },
  {
    value: "balanced" as ResearchDepth,
    label: "Balanced",
    detail: "A dependable mix of breadth and speed.",
  },
  { value: "deep" as ResearchDepth, label: "Deep", detail: "More checks for complex claims." },
  {
    value: "verified" as ResearchDepth,
    label: "Verified",
    detail: "The fullest evidence pass; takes longer.",
  },
];

interface ResearchDepthControlProps {
  depth: ResearchDepth;
  onChange?: (depth: ResearchDepth) => void;
  id?: string;
  compact?: boolean;
  disabled?: boolean;
}

export function ResearchDepthControl({
  depth,
  onChange,
  id = "research-depth",
  compact = false,
  disabled = false,
}: ResearchDepthControlProps) {
  const index = Math.max(
    0,
    RESEARCH_DEPTH_OPTIONS.findIndex((option) => option.value === depth),
  );
  const selected = RESEARCH_DEPTH_OPTIONS[index] ?? RESEARCH_DEPTH_OPTIONS[1]!;
  return (
    <fieldset
      className={`depth-control${compact ? " depth-control-compact" : ""}`}
      disabled={disabled}
    >
      <legend className="preference-label">Research depth</legend>
      <input
        id={id}
        className="depth-slider"
        type="range"
        min="0"
        max={RESEARCH_DEPTH_OPTIONS.length - 1}
        step="1"
        value={index}
        aria-label="Research depth"
        aria-valuetext={selected.label}
        onChange={(event) => {
          const next = RESEARCH_DEPTH_OPTIONS[Number(event.target.value)];
          if (next) onChange?.(next.value);
        }}
      />
      <div className="depth-scale" aria-hidden="true">
        {RESEARCH_DEPTH_OPTIONS.map((option) => (
          <span key={option.value}>{option.label}</span>
        ))}
      </div>
      <p className="preference-help">{selected.detail}</p>
    </fieldset>
  );
}
