import { afterEach, describe, expect, it } from "vitest";
import { selectChatGptModel } from "./analysis-dependencies";

const originalModel = process.env.PERSPECTICA_CHATGPT_MODEL;
const originalAllowedModels = process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS;
const originalManualModels = process.env.PERSPECTICA_MANUAL_CHATGPT_MODELS;

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("PERSPECTICA_CHATGPT_MODEL", originalModel);
  restore("PERSPECTICA_ALLOWED_CHATGPT_MODELS", originalAllowedModels);
  restore("PERSPECTICA_MANUAL_CHATGPT_MODELS", originalManualModels);
});

describe("ChatGPT model selection", () => {
  it("selects manually exposed GPT-5.6 Luna when upstream discovery omits it", () => {
    delete process.env.PERSPECTICA_CHATGPT_MODEL;
    delete process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS;
    delete process.env.PERSPECTICA_MANUAL_CHATGPT_MODELS;

    expect(selectChatGptModel(["account-default", "gpt-5.4", "gpt-5.5"])).toBe("gpt-5.6-luna");
  });

  it("honors an explicitly allowed model returned by account discovery", () => {
    process.env.PERSPECTICA_CHATGPT_MODEL = "chosen-model";
    process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS = "gpt-5.6-luna,chosen-model";

    expect(selectChatGptModel(["other-model", "chosen-model"])).toBe("chosen-model");
  });

  it("honors a manually exposed model selected by the extension", () => {
    delete process.env.PERSPECTICA_CHATGPT_MODEL;
    delete process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS;
    delete process.env.PERSPECTICA_MANUAL_CHATGPT_MODELS;

    expect(selectChatGptModel(["gpt-5.4"], "gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("rejects a model that is neither discovered nor manually exposed", () => {
    process.env.PERSPECTICA_CHATGPT_MODEL = "missing-model";
    process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS = "gpt-5.6-luna,missing-model";

    expect(() => selectChatGptModel(["available-model"])).toThrow("is neither discovered");
  });
});
