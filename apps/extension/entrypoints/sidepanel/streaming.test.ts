import { describe, expect, it } from "vitest";
import { formatElapsedMs, splitStreamChunks, streamDurationMs } from "./streaming";

describe("progressive text helpers", () => {
  it("preserves word spacing while splitting text into readable chunks", () => {
    expect(splitStreamChunks("A smoother streamed sentence.")).toEqual([
      "A ",
      "smoother ",
      "streamed ",
      "sentence.",
    ]);
  });

  it("preserves leading, repeated, and newline whitespace", () => {
    expect(splitStreamChunks("  A  second\nline")).toEqual(["  ", "A  ", "second\n", "line"]);
  });

  it("keeps the reveal quick even for long analysis copy", () => {
    expect(streamDurationMs(2)).toBe(220);
    expect(streamDurationMs(100)).toBe(820);
  });

  it("formats live elapsed progress without adding noisy precision", () => {
    expect(formatElapsedMs(0)).toBe("just started");
    expect(formatElapsedMs(12_300)).toBe("12s elapsed");
    expect(formatElapsedMs(75_000)).toBe("1m 15s elapsed");
  });
});
