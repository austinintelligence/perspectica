import { describe, expect, it } from "vitest";
import { splitStreamChunks, streamDurationMs } from "./streaming";

describe("progressive text helpers", () => {
  it("preserves word spacing while splitting text into readable chunks", () => {
    expect(splitStreamChunks("A smoother streamed sentence.")).toEqual([
      "A ",
      "smoother ",
      "streamed ",
      "sentence.",
    ]);
  });

  it("keeps the reveal quick even for long analysis copy", () => {
    expect(streamDurationMs(2)).toBe(220);
    expect(streamDurationMs(100)).toBe(820);
  });
});
