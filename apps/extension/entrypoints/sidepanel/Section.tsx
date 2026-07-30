import type { ReactNode } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { LoadStatus } from "./report-state";

interface SectionProps {
  id: string;
  title: string;
  status: LoadStatus;
  error?: string | null;
  children: ReactNode;
}

export function shouldRenderSection(status: LoadStatus): boolean {
  return status !== "empty";
}

export function Section({ id, title, status, error, children }: SectionProps) {
  const headingId = `${id}-heading`;
  const reduceMotion = useReducedMotion();
  const transition = {
    duration: reduceMotion ? 0 : 0.16,
    ease: "easeOut" as const,
  };

  if (!shouldRenderSection(status)) return null;

  return (
    <section id={id} aria-busy={status === "loading"} aria-labelledby={headingId}>
      <h2 className="section-kicker" id={headingId}>
        {title}
      </h2>
      <AnimatePresence initial={false} mode="wait">
        {status === "waiting" || status === "loading" ? (
          <m.div
            className="section-loading"
            key="loading"
            initial={reduceMotion ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={transition}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span className="sr-only">Loading {title}</span>
          </m.div>
        ) : status === "error" ? (
          <m.p
            className="section-error"
            role="alert"
            key="error"
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={transition}
          >
            {error ?? "This section could not be completed."}
          </m.p>
        ) : (
          <m.div
            className="section-content"
            key="content"
            initial={reduceMotion ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition}
          >
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </section>
  );
}
