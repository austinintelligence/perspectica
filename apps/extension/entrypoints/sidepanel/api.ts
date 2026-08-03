import type { AnalysisPreferences } from "@perspectica/contracts";
import type { PipelineEvent } from "@perspectica/contracts/events";
import type { ReportSection } from "@perspectica/contracts/report";
import { sendRuntimeRequest, subscribeRuntimePushWithStatus } from "../../src/runtime/client";
import type {
  AnalysisJob,
  ArticlePreview,
  AuthState,
  DeviceAuthorization,
  ExtensionPreferences,
  RuntimeState,
  SearchProviderKind,
} from "../../src/runtime/messages";

export const extensionMode = import.meta.env.WXT_PERSPECTICA_MODE === "demo" ? "demo" : "chatgpt";
export const CHATGPT_HOST_ORIGINS = ["https://auth.openai.com/*", "https://chatgpt.com/*"] as const;

export async function requestChatGptHostAccess(): Promise<void> {
  const granted = await chrome.permissions.request({ origins: [...CHATGPT_HOST_ORIGINS] });
  if (!granted)
    throw new Error(
      "ChatGPT access was not granted. Perspectica needs access to OpenAI sign-in and ChatGPT to connect your account.",
    );
}

export function getRuntimeState(): Promise<RuntimeState> {
  return sendRuntimeRequest<RuntimeState>({ type: "runtime.getState" });
}
export function getArticlePreview(): Promise<ArticlePreview> {
  return sendRuntimeRequest<ArticlePreview>({ type: "article.preview" });
}
export function beginChatGptLogin(remember: boolean): Promise<DeviceAuthorization> {
  return sendRuntimeRequest<DeviceAuthorization>({ type: "auth.begin", remember });
}
export function getPendingChatGptLogin(): Promise<DeviceAuthorization | null> {
  return sendRuntimeRequest<DeviceAuthorization | null>({ type: "auth.getPending" });
}
export function pollChatGptLogin(): Promise<
  { status: "pending" } | { status: "authenticated"; state: AuthState }
> {
  return sendRuntimeRequest({ type: "auth.poll" });
}
export function disconnectChatGpt(): Promise<AuthState> {
  return sendRuntimeRequest<AuthState>({ type: "auth.disconnect" });
}
export function listChatGptModels(): Promise<string[]> {
  return sendRuntimeRequest<string[]>({ type: "auth.listModels" });
}
export function updateExtensionPreferences(
  preferences: ExtensionPreferences,
): Promise<ExtensionPreferences> {
  return sendRuntimeRequest<ExtensionPreferences>({ type: "preferences.update", preferences });
}
export function saveExaApiKey(apiKey: string): Promise<{ saved: true }> {
  return sendRuntimeRequest({ type: "providers.saveExaKey", apiKey });
}
export function testExaApiKey(apiKey: string): Promise<{ available: true }> {
  return sendRuntimeRequest({ type: "providers.testExaKey", apiKey });
}
export function clearExaApiKey(): Promise<{ removed: true }> {
  return sendRuntimeRequest({ type: "providers.clearExaKey" });
}
export function testSearchProvider(
  provider: SearchProviderKind,
): Promise<{ available: boolean; models?: string[] }> {
  return sendRuntimeRequest({ type: "providers.test", provider });
}
export function getAnalysisLogs(): Promise<{ text: string; entryCount: number; jobId: string }> {
  return sendRuntimeRequest({ type: "analysis.getLogs" });
}
export function clearAnalysisLogs(): Promise<{ removed: boolean; jobId?: string }> {
  return sendRuntimeRequest({ type: "analysis.clearLogs" });
}
export function clearResearchCache(): Promise<{ removed: boolean }> {
  return sendRuntimeRequest({ type: "research.cache.clear" });
}

function terminal(status: AnalysisJob["status"]): boolean {
  return ["complete", "partial", "failed", "cancelled"].includes(status);
}

export function isResumableJob(job: AnalysisJob | null | undefined): boolean {
  return Boolean(
    job && ["queued", "extracting", "analyzing", "complete", "partial"].includes(job.status),
  );
}

function comparableUrl(value: string | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isResumableJobForTab(
  job: AnalysisJob | null | undefined,
  tab: Pick<chrome.tabs.Tab, "id" | "url"> | null | undefined,
): boolean {
  return Boolean(
    isResumableJob(job) &&
    tab?.id === job?.tabId &&
    comparableUrl(tab?.url) !== null &&
    comparableUrl(tab?.url) === comparableUrl(job?.tabUrl),
  );
}

export type AnalysisStreamStatus = "connected" | "reconnecting";

function abortError(): DOMException {
  return new DOMException("Analysis cancelled", "AbortError");
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function streamAnalysis(
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
  preferences?: AnalysisPreferences,
  onStatus?: (status: AnalysisStreamStatus) => void,
  options?: { forceNew?: boolean; retrySections?: readonly ReportSection[] },
): Promise<void> {
  if (signal?.aborted) throw abortError();
  const runtime = await getRuntimeState();
  if (preferences) {
    const preferencesWithLegacyMode = preferences as AnalysisPreferences & {
      mode?: ExtensionPreferences["mode"];
    };
    await updateExtensionPreferences({
      ...runtime.preferences,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
      ...(preferencesWithLegacyMode.mode ? { mode: preferencesWithLegacyMode.mode } : {}),
      ...(preferences.depth ? { depth: preferences.depth } : {}),
    });
  }
  if (options?.retrySections?.length && !runtime.activeJob) {
    throw new Error("There is no partial analysis available for a targeted retry.");
  }
  const job = await sendRuntimeRequest<AnalysisJob>(
    options?.retrySections?.length
      ? {
          type: "analysis.retry",
          jobId: runtime.activeJob?.id ?? "",
          sections: [...options.retrySections],
        }
      : {
          type: "analysis.start",
          ...(options?.forceNew ? { forceNew: true } : {}),
        },
  );
  let deliveredSequence = options?.retrySections?.length ? job.lastEventSequence : 0;
  let settled = false;
  let replayInFlight: Promise<void> | null = null;
  let replayRequested = false;
  let connectedReplayStarted = false;
  type StreamEnvelope = {
    jobId: string;
    runToken: string;
    sequence: number;
    revision: number;
    event: PipelineEvent;
  };
  const pendingEnvelopes = new Map<number, StreamEnvelope>();
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((error: Error) => void) | undefined;
  let unsubscribe: () => void = () => {};
  let abortListenerAttached = false;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Abort can settle the terminal promise while the initial journal replay is
  // still in flight. Attach a handler immediately so that expected caller
  // cancellation never becomes an unhandled rejection.
  void done.catch(() => undefined);
  const cleanup = () => {
    unsubscribe();
    if (abortListenerAttached) {
      signal?.removeEventListener("abort", onAbort);
      abortListenerAttached = false;
    }
  };
  const onAbort = () => {
    if (settled) return;
    settled = true;
    cleanup();
    void sendRuntimeRequest({ type: "analysis.cancel", jobId: job.id });
    rejectDone?.(abortError());
  };
  const finishFromEvent = (event: PipelineEvent) => {
    if (settled) return;
    if (event.type === "analysis.completed") {
      settled = true;
      cleanup();
      resolveDone?.();
    }
    if (event.type === "analysis.failed") {
      settled = true;
      cleanup();
      rejectDone?.(new Error(event.data.message));
    }
    if (event.type === "analysis.cancelled") {
      settled = true;
      cleanup();
      rejectDone?.(abortError());
    }
  };
  const applyEnvelope = (envelope: StreamEnvelope, fromReplay = false) => {
    if (settled || envelope.jobId !== job.id || envelope.runToken !== (job.runToken ?? "")) return;
    if (envelope.sequence <= deliveredSequence) return;
    if (envelope.sequence !== deliveredSequence + 1) {
      pendingEnvelopes.set(envelope.sequence, envelope);
      if (!fromReplay) void replay();
      return;
    }
    deliveredSequence = envelope.sequence;
    onEvent(envelope.event);
    finishFromEvent(envelope.event);
    while (!settled) {
      const next = pendingEnvelopes.get(deliveredSequence + 1);
      if (!next) break;
      pendingEnvelopes.delete(next.sequence);
      applyEnvelope(next, true);
    }
  };
  const replay = async () => {
    if (settled) return;
    if (replayInFlight) {
      replayRequested = true;
      return replayInFlight;
    }
    replayInFlight = (async () => {
      do {
        replayRequested = false;
        let hasMore = true;
        while (!settled && hasMore) {
          const response = await sendRuntimeRequest<{
            jobId: string;
            lastSequence: number;
            hasMore?: boolean;
            events: StreamEnvelope[];
            complete: boolean;
          }>({ type: "analysis.getEventsSince", jobId: job.id, lastSequence: deliveredSequence });
          const events = [...response.events].sort((left, right) => left.sequence - right.sequence);
          if (
            events.length === 0 &&
            response.lastSequence > deliveredSequence &&
            !response.complete
          )
            throw new Error(
              "The analysis journal has a missing event gap. Reconnect and try again.",
            );
          for (const envelope of events) applyEnvelope(envelope, true);
          const lastReturned = events.at(-1)?.sequence ?? deliveredSequence;
          hasMore = Boolean(response.hasMore) || lastReturned < response.lastSequence;
          if (hasMore && events.length === 0)
            throw new Error("The analysis journal could not replay its next event.");
          if (!hasMore && response.lastSequence > deliveredSequence)
            throw new Error(
              "The analysis journal has a missing event gap. Reconnect and try again.",
            );
        }
        const finalJob =
          !settled &&
          (await sendRuntimeRequest<AnalysisJob>({ type: "analysis.getJob", jobId: job.id }));
        if (!settled && finalJob && terminal(finalJob.status)) {
          settled = true;
          cleanup();
          if (finalJob.status === "failed") {
            rejectDone?.(new Error(finalJob.error ?? "The analysis failed."));
          } else if (finalJob.status === "cancelled") {
            rejectDone?.(abortError());
          } else {
            resolveDone?.();
          }
        }
      } while (!settled && replayRequested);
    })().finally(() => {
      replayInFlight = null;
    });
    return replayInFlight;
  };
  unsubscribe = subscribeRuntimePushWithStatus(
    (message) => {
      if (message.type === "analysis.eventDelta")
        applyEnvelope({
          jobId: message.jobId,
          runToken: message.runToken ?? "",
          sequence: message.sequence,
          revision: message.revision,
          event: message.event,
        });
      if (
        message.type === "analysis.jobChanged" &&
        message.job.id === job.id &&
        terminal(message.job.status)
      )
        void replay();
    },
    (status) => {
      onStatus?.(status);
      if (status === "connected") {
        connectedReplayStarted = true;
        void replay();
      }
    },
  );
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    abortListenerAttached = true;
    if (signal.aborted) onAbort();
  }
  if (!connectedReplayStarted) {
    connectedReplayStarted = true;
    void replay();
  }
  await abortable(replayInFlight ?? Promise.resolve(), signal);
  if (!settled) await done;
}
