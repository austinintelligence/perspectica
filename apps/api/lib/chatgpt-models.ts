export const DEFAULT_CHATGPT_MODEL = "gpt-5.6-luna";
export const DEFAULT_CHATGPT_REASONING_EFFORT = "medium" as const;
export const DEFAULT_CODEX_CLIENT_VERSION = "0.144.4";

export type ChatGptReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const DEFAULT_MANUALLY_EXPOSED_MODELS = [DEFAULT_CHATGPT_MODEL, "gpt-5.6-sol"];
const DEFAULT_ALLOWED_MODELS = [DEFAULT_CHATGPT_MODEL, "gpt-5.6-sol", "gpt-5.4"];

function parseModelList(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

export function manuallyExposedChatGptModels(): string[] {
  const configured = parseModelList(process.env.PERSPECTICA_MANUAL_CHATGPT_MODELS);
  return configured.length > 0 ? configured : [...DEFAULT_MANUALLY_EXPOSED_MODELS];
}

export function allowedChatGptModels(): string[] {
  const configured = parseModelList(process.env.PERSPECTICA_ALLOWED_CHATGPT_MODELS);
  return configured.length > 0 ? configured : [...DEFAULT_ALLOWED_MODELS];
}

export function mergeChatGptModelIds(
  discovered: readonly string[],
  manuallyExposed: readonly string[] = manuallyExposedChatGptModels(),
): string[] {
  return [
    ...new Set([...discovered, ...manuallyExposed].map((model) => model.trim()).filter(Boolean)),
  ];
}

export function codexClientVersion(): string {
  return process.env.PERSPECTICA_CODEX_CLIENT_VERSION?.trim() || DEFAULT_CODEX_CLIENT_VERSION;
}

export function chatGptReasoningEffort(preferred?: ChatGptReasoningEffort): ChatGptReasoningEffort {
  const configured =
    preferred ?? process.env.PERSPECTICA_CHATGPT_REASONING_EFFORT?.trim().toLowerCase();
  if (!configured) return DEFAULT_CHATGPT_REASONING_EFFORT;
  if (
    configured === "none" ||
    configured === "low" ||
    configured === "medium" ||
    configured === "high" ||
    configured === "xhigh"
  ) {
    return configured;
  }
  throw new Error(
    `Unsupported PERSPECTICA_CHATGPT_REASONING_EFFORT "${configured}". Use none, low, medium, high, or xhigh.`,
  );
}
