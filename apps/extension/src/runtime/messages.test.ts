import { describe, expect, it } from "vitest";
import {
  AnalysisLogInputSchema,
  ExtensionRequestSchema,
  InternalRequestSchema,
  OffscreenCommandSchema,
  PERSPECTICA_RUNTIME_PROTOCOL,
  publicError,
} from "./messages";

describe("extension runtime protocol", () => {
  it("accepts only declared public requests", () => {
    expect(
      ExtensionRequestSchema.safeParse({
        type: "auth.begin",
        requestId: "request-1",
        remember: true,
      }).success,
    ).toBe(true);
    expect(
      ExtensionRequestSchema.safeParse({
        type: "internal.auth.getTokens",
        requestId: "request-2",
      }).success,
    ).toBe(false);
    expect(
      ExtensionRequestSchema.safeParse({
        type: "providers.testExaKey",
        requestId: "request-3",
        apiKey: "test-only-key",
      }).success,
    ).toBe(true);
  });

  it("validates provider probes as offscreen-only commands", () => {
    expect(
      OffscreenCommandSchema.safeParse({
        type: "offscreen.providers.test",
        protocol: PERSPECTICA_RUNTIME_PROTOCOL,
        provider: "chatgpt",
        preferences: {
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
        },
      }).success,
    ).toBe(true);
  });

  it("uses an explicit offscreen handshake to prevent mixed unpacked builds", () => {
    expect(
      OffscreenCommandSchema.safeParse({
        type: "offscreen.runtime.ping",
        protocol: PERSPECTICA_RUNTIME_PROTOCOL,
      }).success,
    ).toBe(true);
    expect(
      OffscreenCommandSchema.safeParse({
        type: "offscreen.runtime.ping",
        protocol: PERSPECTICA_RUNTIME_PROTOCOL - 1,
      }).success,
    ).toBe(false);
  });

  it("redacts common credential shapes from public errors", () => {
    const message = publicError(
      new Error("Bearer abc123 access_token=secret refresh token: hidden"),
      "fallback",
    );

    expect(message).not.toContain("abc123");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("hidden");
    expect(message).toContain("[redacted");
  });

  it("bounds persisted analysis telemetry", () => {
    expect(
      AnalysisLogInputSchema.safeParse({
        timestamp: "2026-07-29T12:00:00.000Z",
        level: "error",
        scope: "research.supporting",
        event: "agent.failed",
        message: "Structured output failed.",
        payload: JSON.stringify({ query: "independent reporting", status: 503 }),
      }).success,
    ).toBe(true);
  });

  it("requires ownership and sequence metadata for runtime analysis messages", () => {
    const base = {
      type: "internal.analysis.finished" as const,
      requestId: "request-3",
      jobId: "job-1",
      runToken: "run-1",
      sequence: 1,
    };
    expect(InternalRequestSchema.safeParse(base).success).toBe(true);
    expect(InternalRequestSchema.safeParse({ ...base, sequence: 0 }).success).toBe(false);
    expect(InternalRequestSchema.safeParse({ ...base, runToken: "" }).success).toBe(false);
  });
});
