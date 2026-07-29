import { afterEach, describe, expect, it } from "vitest";
import {
  allowedChatGptModels,
  chatGptReasoningEffort,
  codexClientVersion,
  manuallyExposedChatGptModels,
  mergeChatGptModelIds,
} from "./chatgpt-models";

const originalClientVersion = process.env.PERSPECTICA_CODEX_CLIENT_VERSION;
const originalAllowedModels = process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS;
const originalManualModels = process.env.PERSPECTICA_MANUAL_CHATGPT_MODELS;
const originalReasoningEffort = process.env.PERSPECTICA_CHATGPT_REASONING_EFFORT;

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("PERSPECTICA_CODEX_CLIENT_VERSION", originalClientVersion);
  restore("PERSPECTICA_ALLOWED_CHATGPT_MODELS", originalAllowedModels);
  restore("PERSPECTICA_MANUAL_CHATGPT_MODELS", originalManualModels);
  restore("PERSPECTICA_CHATGPT_REASONING_EFFORT", originalReasoningEffort);
});

describe("ChatGPT model configuration", () => {
  it("defaults to a GPT-5.6-capable Codex client and manually exposes 5.6 models", () => {
    delete process.env.PERSPECTICA_CODEX_CLIENT_VERSION;
    delete process.env.PERSPECTICA_MANUAL_CHATGPT_MODELS;
    delete process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS;
    delete process.env.PERSPECTICA_CHATGPT_REASONING_EFFORT;

    expect(codexClientVersion()).toBe("0.144.4");
    expect(manuallyExposedChatGptModels()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(allowedChatGptModels()).toContain("gpt-5.6-luna");
    expect(allowedChatGptModels()).toContain("gpt-5.6-sol");
    expect(chatGptReasoningEffort()).toBe("medium");
  });

  it("deduplicates manually exposed and discovered model ids", () => {
    expect(
      mergeChatGptModelIds(["gpt-5.4", "gpt-5.6-luna"], ["gpt-5.6-luna", "gpt-5.6-luna"]),
    ).toEqual(["gpt-5.4", "gpt-5.6-luna"]);
  });

  it("accepts supported effort overrides and rejects unknown values", () => {
    process.env.PERSPECTICA_CHATGPT_REASONING_EFFORT = "high";
    expect(chatGptReasoningEffort()).toBe("high");

    process.env.PERSPECTICA_CHATGPT_REASONING_EFFORT = "pro";
    expect(() => chatGptReasoningEffort()).toThrow("Use none, low, medium, high, or xhigh");
  });

  it("allows a validated request preference to override the environment effort", () => {
    process.env.PERSPECTICA_CHATGPT_REASONING_EFFORT = "low";
    expect(chatGptReasoningEffort("high")).toBe("high");
  });
});
