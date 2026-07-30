import { m, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { splitStreamChunks, streamDurationMs } from "./streaming";

interface ProgressiveTextProps {
  text: string;
  className?: string;
}

function StreamRun({ text }: { text: string }) {
  const reduceMotion = useReducedMotion();
  const chunks = useMemo(() => splitStreamChunks(text), [text]);
  const firstRender = useRef(true);
  useEffect(() => {
    firstRender.current = false;
  }, []);
  const reveal = firstRender.current && !reduceMotion;
  const durationSeconds = streamDurationMs(chunks.length) / 1_000;

  return (
    <>
      {chunks.map((chunk, index) => {
        const word = chunk.match(/^\S+/)?.[0] ?? "";
        const whitespace = chunk.slice(word.length);

        return (
          <Fragment key={`${index}-${chunk}`}>
            <m.span
              animate={reveal ? { opacity: 1, filter: "blur(0px)", y: 0 } : { opacity: 1 }}
              style={reveal ? { display: "inline-block" } : undefined}
              initial={reveal ? { opacity: 0, filter: "blur(2px)", y: 3 } : false}
              transition={{
                duration: reveal ? 0.17 : 0,
                delay:
                  !reveal || chunks.length <= 1
                    ? 0
                    : (index / (chunks.length - 1)) * durationSeconds,
                ease: "easeOut",
              }}
            >
              {word}
            </m.span>
            {whitespace}
          </Fragment>
        );
      })}
    </>
  );
}

export function ProgressiveText({ text, className }: ProgressiveTextProps) {
  return (
    <span className={`progressive-text${className ? ` ${className}` : ""}`}>
      <StreamRun key={text} text={text} />
    </span>
  );
}
