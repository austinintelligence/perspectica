import { m, useReducedMotion } from "motion/react";
import { Fragment, useMemo } from "react";
import { splitStreamChunks, streamDurationMs } from "./streaming";

interface ProgressiveTextProps {
  text: string;
  className?: string;
}

function StreamRun({ text }: { text: string }) {
  const reduceMotion = useReducedMotion();
  const chunks = useMemo(() => splitStreamChunks(text), [text]);
  const durationSeconds = streamDurationMs(chunks.length) / 1_000;

  return (
    <>
      {chunks.map((chunk, index) => {
        const word = chunk.match(/^\S+/)?.[0] ?? chunk;
        const whitespace = chunk.slice(word.length);

        return (
          <Fragment key={`${index}-${chunk}`}>
            <m.span
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, filter: "blur(0px)", y: 0 }}
              style={reduceMotion ? undefined : { display: "inline-block" }}
              initial={reduceMotion ? false : { opacity: 0, filter: "blur(2px)", y: 3 }}
              transition={{
                duration: reduceMotion ? 0 : 0.17,
                delay:
                  reduceMotion || chunks.length <= 1
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
