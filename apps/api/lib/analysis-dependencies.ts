import type { AnalysisDependencies } from "@perspectica/analysis";
import type { AnalysisPreferences } from "@perspectica/contracts";
import { AiSdkArticleLensProvider } from "@perspectica/analysis/ai-sdk";
import { DemoArticleLensProvider, DemoResearchProvider } from "@perspectica/analysis/demo";
import { AgenticAiSdkResearchProvider } from "@perspectica/analysis/agentic-research";
import { createChatGPTProxyProvider } from "@opencoredev/loginwithchatgpt-ai";
import { getPerspecticaChatGptAuth } from "./chatgpt-auth";
import {
  allowedChatGptModels,
  chatGptReasoningEffort,
  DEFAULT_CHATGPT_MODEL,
  mergeChatGptModelIds,
} from "./chatgpt-models";
import { ExaSearchProvider, type ExaSearchCache } from "./exa-search";

const exaSearchCache: ExaSearchCache = new Map();

export class ChatGptConnectionRequiredError extends Error {
  readonly status = 401;

  constructor(message = "Connect ChatGPT in the Perspectica side panel before analyzing.") {
    super(message);
    this.name = "ChatGptConnectionRequiredError";
  }
}

export function selectChatGptModel(models: string[], preferredModel?: string): string {
  const allowed = new Set(allowedChatGptModels());
  const selectable = mergeChatGptModelIds(models).filter((model) => allowed.has(model));
  if (preferredModel) {
    if (!selectable.includes(preferredModel)) {
      throw new Error(
        `The selected ChatGPT model "${preferredModel}" is neither discovered nor manually exposed and allowed.`,
      );
    }
    return preferredModel;
  }
  const configured = process.env.PERSPECTICA_CHATGPT_MODEL?.trim();
  if (configured) {
    if (!selectable.includes(configured)) {
      throw new Error(
        `The configured ChatGPT model "${configured}" is neither discovered nor manually exposed and allowed.`,
      );
    }
    return configured;
  }

  if (!selectable.includes(DEFAULT_CHATGPT_MODEL)) {
    throw new Error(
      `The required ChatGPT model "${DEFAULT_CHATGPT_MODEL}" is not exposed by the current configuration.`,
    );
  }
  return DEFAULT_CHATGPT_MODEL;
}

function useDemoMode(): boolean {
  return process.env.NODE_ENV === "test" || process.env.PERSPECTICA_MODE === "demo";
}

export async function createAnalysisDependencies(
  request: Request,
  preferences?: AnalysisPreferences,
): Promise<AnalysisDependencies> {
  if (useDemoMode()) {
    return {
      articleLens: new DemoArticleLensProvider(),
      research: new DemoResearchProvider(),
      mode: "demo",
      pipelineVersion: process.env.PERSPECTICA_PIPELINE_VERSION ?? "2026-07-29.1",
      promptVersion: "demo-rules-v1",
      modelVersion: "demo-rules-v1",
      reasoningEffort: "none",
    };
  }

  const auth = getPerspecticaChatGptAuth();
  const session = await auth.getSession(request);
  if (session.status !== "authenticated") {
    throw new ChatGptConnectionRequiredError();
  }

  const model = selectChatGptModel((await auth.getModels(request)) ?? [], preferences?.model);
  const reasoningEffort = chatGptReasoningEffort(preferences?.reasoningEffort);
  const chatgpt = createChatGPTProxyProvider({
    basePath: "/api/chatgpt",
    defaultModel: model,
    fetch: auth.proxyFetch(request),
    headers: {
      "x-login-with-chatgpt-reasoning-effort": reasoningEffort,
    },
  });
  const languageModel = chatgpt(model);
  const articleLens = new AiSdkArticleLensProvider({
    model: languageModel,
    promptVersion: process.env.PERSPECTICA_PROMPT_VERSION ?? "agentic-research-v1",
  });
  const research = new AgenticAiSdkResearchProvider({
    model: languageModel,
    searchProvider: new ExaSearchProvider({
      apiKey: process.env.EXA_API_KEY ?? "",
      cache: exaSearchCache,
    }),
    onDiagnostics: (diagnostics) => {
      const message = `[perspectica] specialist=${diagnostics.section} status=${diagnostics.status} durationMs=${diagnostics.durationMs} targetExceeded=${diagnostics.targetExceeded} queries=${diagnostics.queryCount} searchCalls=${diagnostics.searchCalls} candidates=${diagnostics.candidateCount} sourceReads=${diagnostics.sourceReads} deepSearches=${diagnostics.deepSearches} modelSteps=${diagnostics.modelSteps}${diagnostics.error ? ` error=${JSON.stringify(diagnostics.error)}` : ""}`;
      if (diagnostics.status === "failed") console.error(message);
      else console.info(message);
    },
  });

  return {
    articleLens,
    research,
    mode: "live",
    pipelineVersion: process.env.PERSPECTICA_PIPELINE_VERSION ?? "2026-07-29.1",
    promptVersion: articleLens.promptVersion,
    modelVersion: model,
    reasoningEffort,
  };
}
