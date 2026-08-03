import type { ReactNode } from "react";
import type { LoadStatus } from "./report-state";

interface SectionProps {
  id: string;
  title: string;
  status: LoadStatus;
  error?: string | null;
  onRetry?: () => void;
  children: ReactNode;
}

export function shouldRenderSection(status: LoadStatus): boolean {
  return status !== "empty";
}

export function Section({ id, title, status, error, onRetry, children }: SectionProps) {
  const headingId = `${id}-heading`;
  if (!shouldRenderSection(status)) return null;

  return (
    <section id={id} aria-busy={status === "loading"} aria-labelledby={headingId}>
      <h2 className="section-kicker" id={headingId}>
        {title}
      </h2>
      {status === "waiting" || status === "loading" ? (
        <div className="section-loading" aria-live="polite">
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span className="sr-only">Loading {title}</span>
        </div>
      ) : status === "error" ? (
        <div className="section-error" role="alert">
          <p>{error ?? "This section could not be completed."}</p>
          {onRetry ? (
            <button className="section-retry" type="button" onClick={onRetry}>
              Retry {title}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="section-content">{children}</div>
      )}
    </section>
  );
}
