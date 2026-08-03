import { createChatGPT } from "@opencoredev/loginwithchatgpt-ai";
import type { ChatGPTTokens, ReasoningEffort } from "@opencoredev/loginwithchatgpt-core";
import {
  analyzeArticle,
  retryArticleSections,
  type AnalysisArtifacts,
  type PipelineTelemetry,
} from "@perspectica/intelligence";
import { EvidenceLedger } from "@perspectica/intelligence";
import type { EvidenceRetriever } from "@perspectica/contracts/evidence";
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
import { ExaEvidenceRetriever } from "../../src/providers/exa-evidence";
import { NativeChatGptEvidenceRetriever } from "../../src/providers/chatgpt-evidence";
import { IndexedDbAnalysisArtifactStore } from "../../src/storage/analysis-artifacts";
import { EvidenceCache } from "../../src/storage/evidence-cache";
import { describeError, redactText, serializeRedacted } from "../../src/runtime/redaction";

const activeJobs = new Map<string, { controller: AbortController; runToken: string }>();
const completedArtifacts = new Map<string, AnalysisArtifacts>();
const artifactStore = new IndexedDbAnalysisArtifactStore();
const telemetryTails = new Map<string, Promise<void>>();

function artifactKey(jobId: string, runToken: string): string {
  return `${jobId}:${runToken}`;
}

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
  const next: Promise<void> = previous
    .catch(() => undefined)
    .then(() => sendInternal({ type: "internal.analysis.log", jobId, entry: sanitized }))
    .then(() => undefined)
    .catch((error: unknown) => {
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
      if (attempt + 1 < attempts)
        await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The extension runtime is unavailable.");
}

function logTelemetry(jobId: string, telemetry: PipelineTelemetry): void {
  void queueTelemetry(jobId, {
    level: "info",
    scope: "pipeline",
    event: "phase.snapshot",
    message: "V2 pipeline telemetry snapshot.",
    payload: serializeRedacted({
      modelCalls: telemetry.modelCalls,
      searchCalls: telemetry.searchCalls,
      contentReads: telemetry.contentReads,
      acceptedSources: telemetry.acceptedSources,
      rejectedSources: telemetry.rejectedSources,
      eventBytes: telemetry.eventBytes,
      cacheHits: telemetry.cacheHits,
      firstUsefulResultMs: telemetry.firstUsefulResultMs,
      finalLatencyMs: telemetry.finalLatencyMs,
      debugRing: telemetry.debugRing.slice(-8),
    }),
  });
}

async function createRetriever(
  jobId: string,
  modelId: string,
  reasoningEffort: ReasoningEffort,
  providerKind: SearchProviderKind,
): Promise<{ model: ReturnType<ReturnType<typeof createChatGPT>>; retriever: EvidenceRetriever }> {
  const chatgpt = createChatGPT({
    credentials: () => sendInternal<ChatGPTTokens>({ type: "internal.auth.getTokens" }),
    defaultModel: modelId,
    reasoningEffort,
    textVerbosity: "low",
  });
  if (providerKind === "exa") {
    const secret = await sendInternal<{ apiKey: string }>({
      type: "internal.providers.getSecret",
      provider: "exa",
    });
    return {
      model: chatgpt(modelId),
      retriever: new ExaEvidenceRetriever(
        secret.apiKey,
        undefined,
        (diagnostics) => {
          void queueTelemetry(jobId, {
            level: diagnostics.outcome === "failed" ? "error" : "debug",
            scope: "provider.exa",
            event: `mission.${diagnostics.outcome}`,
            message: `Exa mission ${diagnostics.missionId} ${diagnostics.outcome}.`,
            payload: serializeRedacted(diagnostics),
          });
        },
        new EvidenceCache(),
      ),
    };
  }
  return {
    model: chatgpt(modelId),
    retriever: new NativeChatGptEvidenceRetriever(
      chatgpt,
      modelId,
      (diagnostics) => {
        void queueTelemetry(jobId, {
          level: diagnostics.outcome === "failed" ? "error" : "debug",
          scope: "provider.chatgpt",
          event: `global-search.${diagnostics.outcome}`,
          message: "Native ChatGPT global search completed.",
          payload: serializeRedacted(diagnostics),
        });
      },
      new EvidenceCache(),
    ),
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
  if (command.provider !== "chatgpt")
    throw new Error("Only ChatGPT web search is tested in the analysis runtime.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const retriever = new NativeChatGptEvidenceRetriever(chatgpt, command.preferences.model);
    const iterator = retriever.retrieve(
      {
        missions: [
          {
            id: "probe",
            claimIds: [],
            purpose: "missing-background",
            queryVariants: ["OpenAI official website"],
            priority: 1,
            estimatedCost: 1,
            freshness: "timeless",
            preferredSourceTypes: ["direct-source"],
            includeDomains: ["openai.com"],
            excludeDomains: [],
            canServeSections: ["additional-context"],
          },
        ],
        maxSources: 1,
        maxConcurrency: 1,
        deadlineAt: Date.now() + 45_000,
      },
      controller.signal,
    );
    const first = await iterator[Symbol.asyncIterator]().next();
    const sourceCount = first.done ? 0 : first.value.cards.length;
    if (sourceCount === 0)
      throw new Error("ChatGPT completed the request but did not return a web source.");
    return { available: true, sourceCount };
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
  let sequence = command.initialSequence;
  const startedAt = Date.now();
  try {
    const preferences = command.request.preferences ?? {
      model: "gpt-5.6-luna" as const,
      reasoningEffort: "medium" as const,
      mode: "balanced" as const,
    };
    const { model, retriever } = await createRetriever(
      jobId,
      preferences.model,
      preferences.reasoningEffort,
      command.searchProvider,
    );
    for await (const event of analyzeArticle({
      article: command.request.article,
      retriever,
      model,
      modelVersion: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
      mode: preferences.mode,
      signal: controller.signal,
      onTelemetry: (telemetry) => logTelemetry(jobId, telemetry),
      onArtifacts: async (artifacts) => {
        for (const key of completedArtifacts.keys()) {
          if (key !== artifactKey(jobId, command.runToken)) completedArtifacts.delete(key);
        }
        completedArtifacts.set(artifactKey(jobId, command.runToken), artifacts);
        await artifactStore.set(jobId, command.runToken, artifacts);
      },
    })) {
      void queueTelemetry(jobId, {
        timestamp: event.emittedAt,
        level: event.type === "analysis.failed" ? "error" : "info",
        scope: "pipeline.events",
        event: event.type,
        message: `${event.type} emitted.`,
        payload: serializeRedacted(event.data),
      });
      await sendInternal({
        type: "internal.analysis.event",
        jobId,
        runToken: command.runToken,
        sequence: ++sequence,
        event,
      });
    }
    await flushTelemetry(jobId);
    await sendInternal({
      type: "internal.analysis.finished",
      jobId,
      runToken: command.runToken,
      sequence: ++sequence,
    });
    console.info(
      `[perspectica] job=${jobId} V2 pipeline completed durationMs=${Date.now() - startedAt}`,
    );
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(`[perspectica] job=${jobId} failed`, describeError(error));
      await flushTelemetry(jobId);
      try {
        await sendInternal(
          {
            type: "internal.analysis.failed",
            jobId,
            runToken: command.runToken,
            sequence: ++sequence,
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
    }
  } finally {
    if (activeJobs.get(jobId)?.controller === controller) activeJobs.delete(jobId);
  }
}

async function runRetryJob(
  jobId: string,
  command: Extract<
    ReturnType<typeof OffscreenCommandSchema.parse>,
    { type: "offscreen.analysis.retry" }
  >,
): Promise<void> {
  activeJobs.get(jobId)?.controller.abort();
  const controller = new AbortController();
  activeJobs.set(jobId, { controller, runToken: command.runToken });
  let sequence = command.initialSequence;
  let artifacts = completedArtifacts.get(artifactKey(jobId, command.runToken));
  try {
    if (!artifacts) {
      const persisted = await artifactStore.get(jobId, command.runToken);
      if (persisted) {
        artifacts = {
          ...persisted,
          ledger: EvidenceLedger.fromSnapshot(
            persisted.index,
            persisted.plan,
            persisted.budget,
            persisted.ledger,
          ),
        };
        completedArtifacts.set(artifactKey(jobId, command.runToken), artifacts);
      }
    }
    if (!artifacts) {
      throw new Error(
        "The bounded retry context is unavailable after the analysis runtime restarted.",
      );
    }
    const preferences = command.request.preferences ?? {
      model: "gpt-5.6-luna" as const,
      reasoningEffort: "medium" as const,
      mode: "balanced" as const,
    };
    const { retriever } = await createRetriever(
      jobId,
      preferences.model,
      preferences.reasoningEffort,
      command.searchProvider,
    );
    for await (const event of retryArticleSections({
      artifacts,
      retriever,
      sections: command.sections,
      signal: controller.signal,
      onTelemetry: (telemetry) => logTelemetry(jobId, telemetry),
    })) {
      void queueTelemetry(jobId, {
        timestamp: event.emittedAt,
        level: event.type === "analysis.failed" ? "error" : "info",
        scope: "pipeline.events",
        event: event.type,
        message: `${event.type} emitted.`,
        payload: serializeRedacted(event.data),
      });
      await sendInternal({
        type: "internal.analysis.event",
        jobId,
        runToken: command.runToken,
        sequence: ++sequence,
        event,
      });
    }
    await flushTelemetry(jobId);
    await sendInternal({
      type: "internal.analysis.finished",
      jobId,
      runToken: command.runToken,
      sequence: ++sequence,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      await flushTelemetry(jobId);
      try {
        await sendInternal(
          {
            type: "internal.analysis.failed",
            jobId,
            runToken: command.runToken,
            sequence: ++sequence,
            error: publicError(error, "The bounded section retry failed."),
          },
          5,
        );
      } catch (deliveryError) {
        console.error(
          "[perspectica] could not deliver targeted retry failure",
          describeError(deliveryError),
        );
      }
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
  if (command.data.type === "offscreen.analysis.retry") {
    void runRetryJob(command.data.jobId, command.data);
    sendResponse({ accepted: true });
    return false;
  }
  const active = activeJobs.get(command.data.jobId);
  if (active?.runToken === command.data.runToken && !active.controller.signal.aborted) {
    sendResponse({ accepted: true, alreadyRunning: true });
    return false;
  }
  void runJob(command.data.jobId, command.data);
  sendResponse({ accepted: true });
  return false;
});
