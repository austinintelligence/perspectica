import type { AnalysisPreferences } from "@perspectica/contracts";
import type { PipelineEvent } from "@perspectica/contracts/events";
import type { ReportSection } from "@perspectica/contracts/report";
import { sendRuntimeRequest, subscribeRuntimePushWithStatus } from "../../src/runtime/client";
import type {
  AnalysisJob,
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
    await updateExtensionPreferences({
      ...runtime.preferences,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
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
  let deliveredRevision = 0;
  let settled = false;
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
  const applyEnvelope = (envelope: {
    jobId: string;
    runToken: string;
    sequence: number;
    revision: number;
    event: PipelineEvent;
  }) => {
    if (settled || envelope.jobId !== job.id || envelope.runToken !== (job.runToken ?? "")) return;
    if (envelope.sequence <= deliveredSequence) return;
    deliveredSequence = envelope.sequence;
    deliveredRevision = Math.max(deliveredRevision, envelope.revision);
    onEvent(envelope.event);
    finishFromEvent(envelope.event);
  };
  const replay = async () => {
    if (settled) return;
    const response = await sendRuntimeRequest<{
      jobId: string;
      lastSequence: number;
      events: Array<{
        jobId: string;
        runToken: string;
        sequence: number;
        revision: number;
        event: PipelineEvent;
      }>;
      complete: boolean;
    }>({ type: "analysis.getEventsSince", jobId: job.id, lastSequence: deliveredSequence });
    for (const envelope of response.events) applyEnvelope(envelope);
    deliveredRevision = Math.max(deliveredRevision, job.revision ?? 0);
    const finalJob = response.complete
      ? await sendRuntimeRequest<AnalysisJob>({ type: "analysis.getJob", jobId: job.id })
      : null;
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
      if (status === "connected" && deliveredSequence > 0) void replay();
    },
  );
  onStatus?.("connected");
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    abortListenerAttached = true;
    if (signal.aborted) onAbort();
  }
  await abortable(replay(), signal);
  if (!settled) await done;
}
