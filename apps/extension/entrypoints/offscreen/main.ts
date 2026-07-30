import { createChatGPT } from "@opencoredev/loginwithchatgpt-ai";
import type { ChatGPTTokens, ReasoningEffort } from "@opencoredev/loginwithchatgpt-core";
import { runAnalysis, type AnalysisDependencies } from "@perspectica/analysis";
import {
  AgenticAiSdkResearchProvider,
  type AgenticResearchDiagnostics,
  type AgenticResearchTrace,
} from "@perspectica/analysis/agentic-research";
import { AiSdkArticleLensProvider } from "@perspectica/analysis/ai-sdk";
import {
  ExtensionResponseSchema,
  OffscreenCommandSchema,
  PERSPECTICA_RUNTIME_PROTOCOL,
  createRequestId,
  publicError,
  type AnalysisLogInput,
  type InternalRequestInput,
  type SearchProviderKind,
} from "../../src/runtime/messages";
import { ExaSearchProvider, type ExaRequestDiagnostics } from "../../src/providers/exa";
import { NativeChatGptSearchProvider } from "../../src/providers/native-chatgpt-search";
import { describeError, redactText, serializeRedacted } from "../../src/runtime/redaction";

const activeJobs = new Map<string, { controller: AbortController; runToken: string }>();
const telemetryTails = new Map<string, Promise<void>>();

function queueTelemetry(
  jobId: string,
  entry: Omit<AnalysisLogInput, "timestamp"> & { timestamp?: string },
): Promise<void> {
  const sanitized: AnalysisLogInput = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    level: entry.level,
    scope: entry.scope,
    event: entry.event,
    message: redactText(entry.message),
    payload: entry.payload ? redactText(entry.payload) : null,
  };
  const previous = telemetryTails.get(jobId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() =>
      sendInternal({
        type: "internal.analysis.log",
        jobId,
        entry: sanitized,
      }),
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      // Telemetry is diagnostic only. A storage/message failure must never
      // turn an otherwise healthy analysis into a failed run.
      console.warn("[perspectica] telemetry persistence failed", describeError(error));
    });
  telemetryTails.set(jobId, next);
  void next.finally(() => {
    if (telemetryTails.get(jobId) === next) telemetryTails.delete(jobId);
  });
  return next;
}

async function flushTelemetry(jobId: string): Promise<void> {
  await telemetryTails.get(jobId)?.catch(() => undefined);
}

function logResearchDiagnostics(jobId: string, diagnostics: AgenticResearchDiagnostics): void {
  const details = [
    `section=${diagnostics.section}`,
    `status=${diagnostics.status}`,
    `durationMs=${diagnostics.durationMs}`,
    `queries=${diagnostics.queryCount}`,
    `candidates=${diagnostics.candidateCount}`,
    `sourceReads=${diagnostics.sourceReads}`,
    `modelSteps=${diagnostics.modelSteps}`,
    ...(diagnostics.error ? [`error=${serializeRedacted(diagnostics.error) ?? "[redacted]"}`] : []),
  ];
  console.info(`[perspectica] ${details.join(" ")}`);
  void queueTelemetry(jobId, {
    level: diagnostics.status === "failed" ? "error" : "info",
    scope: `research.${diagnostics.section}`,
    event: `specialist.${diagnostics.status}`,
    message: `${diagnostics.section} specialist ${diagnostics.status}.`,
    payload: serializeRedacted(diagnostics),
  });
}

function logResearchTrace(jobId: string, trace: AgenticResearchTrace): void {
  const level = trace.event.endsWith(".failed")
    ? "error"
    : trace.event.endsWith(".retrying")
      ? "warn"
      : trace.event.includes("queued")
        ? "debug"
        : "info";
  void queueTelemetry(jobId, {
    level,
    scope: `research.${trace.section}`,
    event: trace.event,
    message: trace.message,
    payload: serializeRedacted(trace.data),
  });
}

function logExaDiagnostics(jobId: string, diagnostics: ExaRequestDiagnostics): void {
  void queueTelemetry(jobId, {
    level:
      diagnostics.outcome === "failed"
        ? "error"
        : diagnostics.outcome === "retrying"
          ? "warn"
          : "debug",
    scope: "provider.exa",
    event: `request.${diagnostics.outcome}`,
    message: `Exa ${diagnostics.endpoint} attempt ${diagnostics.attempt} ${diagnostics.outcome}.`,
    payload: serializeRedacted(diagnostics),
  });
}

async function sendInternal<T>(request: InternalRequestInput, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = ExtensionResponseSchema.parse(
        await chrome.runtime.sendMessage({ ...request, requestId: createRequestId() }),
      );
      if (!response.ok) throw new Error(response.error);
      return response.data as T;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The extension runtime is unavailable.");
}

async function createDependencies(
  jobId: string,
  modelId: string,
  reasoningEffort: ReasoningEffort,
  searchProviderKind: SearchProviderKind,
): Promise<AnalysisDependencies> {
  const chatgpt = createChatGPT({
    credentials: () => sendInternal<ChatGPTTokens>({ type: "internal.auth.getTokens" }),
    defaultModel: modelId,
    reasoningEffort,
    textVerbosity: "low",
  });
  const searchProvider =
    searchProviderKind === "exa"
      ? new ExaSearchProvider(
          (
            await sendInternal<{ apiKey: string }>({
              type: "internal.providers.getSecret",
              provider: "exa",
            })
          ).apiKey,
          undefined,
          (diagnostics) => logExaDiagnostics(jobId, diagnostics),
        )
      : new NativeChatGptSearchProvider(chatgpt, modelId);
  const model = chatgpt(modelId);
  const articleLensProvider = new AiSdkArticleLensProvider({
    model,
    promptVersion: "self-contained-article-lens-v1",
  });
  const articleLens: AnalysisDependencies["articleLens"] = {
    analyze: async (request, signal) => {
      const startedAt = Date.now();
      void queueTelemetry(jobId, {
        level: "info",
        scope: "article-lens",
        event: "model.started",
        message: "Article Lens model call started.",
        payload: serializeRedacted({
          title: request.article.title,
          paragraphCount: request.article.paragraphs.length,
          model: modelId,
          reasoningEffort,
        }),
      });
      try {
        const output = await articleLensProvider.analyze(request, signal);
        void queueTelemetry(jobId, {
          level: "info",
          scope: "article-lens",
          event: "model.completed",
          message: "Article Lens produced valid structured output.",
          payload: serializeRedacted({
            durationMs: Date.now() - startedAt,
            compassEvidenceCount: output.compassEvidence.length,
            biasCandidateCount: output.biasCandidates.length,
            claimCount: output.dossier?.claims.length ?? 0,
            researchQuestionCount: output.dossier?.researchQuestions.length ?? 0,
          }),
        });
        return output;
      } catch (error) {
        void queueTelemetry(jobId, {
          level: "error",
          scope: "article-lens",
          event: "model.failed",
          message: "Article Lens failed.",
          payload: serializeRedacted({
            durationMs: Date.now() - startedAt,
            error,
          }),
        });
        throw error;
      }
    },
  };
  const research = new AgenticAiSdkResearchProvider({
    model,
    searchProvider,
    // Keep every research lane eligible to progress while matching the shared
    // network gate to both built-in providers' two-request concurrency limit.
    // A separate model-agent cap prevents independent sections from queueing.
    maxConcurrentAgents: 6,
    maxConcurrentSearches: 2,
    onDiagnostics: (diagnostics) => logResearchDiagnostics(jobId, diagnostics),
    onTrace: (trace) => logResearchTrace(jobId, trace),
  });
  return {
    articleLens,
    research,
    mode: "live",
    pipelineVersion: "self-contained-agentic-2026-07-29.4",
    promptVersion: articleLensProvider.promptVersion,
    modelVersion: modelId,
    reasoningEffort,
  };
}

async function testSearchProvider(
  command: Extract<
    ReturnType<typeof OffscreenCommandSchema.parse>,
    { type: "offscreen.providers.test" }
  >,
): Promise<{ available: true; sourceCount: number }> {
  const chatgpt = createChatGPT({
    credentials: () => sendInternal<ChatGPTTokens>({ type: "internal.auth.getTokens" }),
    defaultModel: command.preferences.model,
    reasoningEffort: command.preferences.reasoningEffort,
    textVerbosity: "low",
  });
  if (command.provider !== "chatgpt") {
    throw new Error("Only ChatGPT search is tested in the analysis runtime.");
  }
  const provider = new NativeChatGptSearchProvider(chatgpt, command.preferences.model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const sources = await provider.search({
      query: "OpenAI official website",
      topic: "general",
      maxResults: 1,
      excludeDomains: [],
      includeDomains: ["openai.com"],
      signal: controller.signal,
    });
    if (sources.length === 0) {
      throw new Error("ChatGPT completed the request but did not return a web source.");
    }
    return { available: true, sourceCount: sources.length };
  } finally {
    clearTimeout(timeout);
  }
}

async function runJob(
  jobId: string,
  command: Extract<
    ReturnType<typeof OffscreenCommandSchema.parse>,
    { type: "offscreen.analysis.start" }
  >,
): Promise<void> {
  activeJobs.get(jobId)?.controller.abort();
  const controller = new AbortController();
  activeJobs.set(jobId, { controller, runToken: command.runToken });
  let eventSequence = command.initialSequence;
  const startedAt = Date.now();
  console.info(
    `[perspectica] job=${jobId} model=${command.request.preferences?.model ?? "gpt-5.6-luna"} provider=${command.searchProvider} started`,
  );
  try {
    void queueTelemetry(jobId, {
      level: "info",
      scope: "analysis",
      event: "job.started",
      message: "Analysis job started.",
      payload: serializeRedacted({
        jobId,
        runToken: command.runToken,
        extensionVersion: command.request.client.extensionVersion,
        model: command.request.preferences?.model ?? "gpt-5.6-luna",
        reasoningEffort: command.request.preferences?.reasoningEffort ?? "medium",
        searchProvider: command.searchProvider,
        article: {
          title: command.request.article.title,
          author: command.request.article.author,
          publication: command.request.article.publication,
          canonicalUrl: command.request.article.canonicalUrl,
          contentType: command.request.article.contentType,
          paragraphCount: command.request.article.paragraphs.length,
          originalLinkCount: command.request.article.links.length,
        },
        online: navigator.onLine,
      }),
    });
    const preferences = command.request.preferences ?? {
      model: "gpt-5.6-luna" as const,
      reasoningEffort: "medium" as const,
    };
    const dependencies = await createDependencies(
      jobId,
      preferences.model,
      preferences.reasoningEffort,
      command.searchProvider,
    );
    for await (const event of runAnalysis(command.request, dependencies, controller.signal)) {
      // Deliver the reader-facing event first. Telemetry is serialized on its
      // own best-effort tail and flushed only at the terminal boundary.
      void queueTelemetry(jobId, {
        timestamp: event.emittedAt,
        level: event.type === "section.failed" ? "error" : "info",
        scope: "analysis.events",
        event: event.type,
        message:
          event.type === "section.failed"
            ? `${event.data.section} emitted a failure event.`
            : `${event.type} emitted.`,
        payload: serializeRedacted(event.data),
      });
      await sendInternal({
        type: "internal.analysis.event",
        jobId,
        runToken: command.runToken,
        sequence: ++eventSequence,
        event,
      });
    }
    void queueTelemetry(jobId, {
      level: "info",
      scope: "analysis",
      event: "job.completed",
      message: "Analysis generator completed.",
      payload: serializeRedacted({ durationMs: Date.now() - startedAt }),
    });
    await flushTelemetry(jobId);
    await sendInternal({
      type: "internal.analysis.finished",
      jobId,
      runToken: command.runToken,
      sequence: ++eventSequence,
    });
    console.info(`[perspectica] job=${jobId} completed durationMs=${Date.now() - startedAt}`);
  } catch (error) {
    console.error(
      `[perspectica] job=${jobId} failed durationMs=${Date.now() - startedAt}`,
      describeError(error),
    );
    if (!controller.signal.aborted) {
      void queueTelemetry(jobId, {
        level: "error",
        scope: "analysis",
        event: "job.failed",
        message: "Analysis runtime stopped unexpectedly.",
        payload: serializeRedacted({
          durationMs: Date.now() - startedAt,
          online: navigator.onLine,
          error,
        }),
      });
      await flushTelemetry(jobId);
      try {
        await sendInternal(
          {
            type: "internal.analysis.failed",
            jobId,
            runToken: command.runToken,
            sequence: ++eventSequence,
            error: publicError(error, "The analysis runtime stopped unexpectedly."),
          },
          5,
        );
      } catch (deliveryError) {
        console.error(
          "[perspectica] could not deliver terminal failure",
          describeError(deliveryError),
        );
      }
    } else {
      void queueTelemetry(jobId, {
        level: "warn",
        scope: "analysis",
        event: "job.cancelled",
        message: "Analysis job was cancelled.",
        payload: serializeRedacted({ durationMs: Date.now() - startedAt }),
      });
      await flushTelemetry(jobId);
    }
  } finally {
    if (activeJobs.get(jobId)?.controller === controller) activeJobs.delete(jobId);
  }
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const command = OffscreenCommandSchema.safeParse(raw);
  if (!command.success) return false;
  if (command.data.type === "offscreen.runtime.ping") {
    sendResponse({ ok: true, protocol: PERSPECTICA_RUNTIME_PROTOCOL });
    return false;
  }
  if (command.data.type === "offscreen.providers.test") {
    void testSearchProvider(command.data).then(
      (result) => sendResponse({ ok: true, data: result }),
      (error: unknown) =>
        sendResponse({
          ok: false,
          error: publicError(error, "ChatGPT web search is not available for this account."),
        }),
    );
    return true;
  }
  if (command.data.type === "offscreen.analysis.cancel") {
    const active = activeJobs.get(command.data.jobId);
    const accepted = Boolean(active && active.runToken === command.data.runToken);
    if (accepted && active) {
      active.controller.abort();
      activeJobs.delete(command.data.jobId);
    }
    sendResponse({ accepted, cancelled: accepted });
    return false;
  }
  const active = activeJobs.get(command.data.jobId);
  if (active?.runToken === command.data.runToken && !active.controller.signal.aborted) {
    // Background service workers may be recreated many times during one long
    // analysis. A matching resume command is an idempotent ownership check,
    // not a request to abort and restart healthy model work.
    sendResponse({ accepted: true, alreadyRunning: true });
    return false;
  }
  void runJob(command.data.jobId, command.data);
  sendResponse({ accepted: true });
  return false;
});
