import type { AnalysisEvent, AnalysisPreferences } from "@perspectica/contracts";
import { sendRuntimeRequest, subscribeRuntimePush } from "../../src/runtime/client";
import type {
  AnalysisJob,
  AuthState,
  DeviceAuthorization,
  ExtensionPreferences,
  RuntimeState,
  SearchProviderKind,
} from "../../src/runtime/messages";

export const extensionMode = import.meta.env.WXT_PERSPECTICA_MODE === "demo" ? "demo" : "chatgpt";

/**
 * Host access required by Login with ChatGPT itself. Keep this deliberately
 * narrower than the separate, optional all-sites permission used to read an
 * article after onboarding.
 */
export const CHATGPT_HOST_ORIGINS = ["https://auth.openai.com/*", "https://chatgpt.com/*"] as const;

export async function requestChatGptHostAccess(): Promise<void> {
  const granted = await chrome.permissions.request({
    origins: [...CHATGPT_HOST_ORIGINS],
  });
  if (!granted) {
    throw new Error(
      "ChatGPT access was not granted. Perspectica needs access to OpenAI sign-in and ChatGPT to connect your account.",
    );
  }
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
  return sendRuntimeRequest<ExtensionPreferences>({
    type: "preferences.update",
    preferences,
  });
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

export function getAnalysisLogs(): Promise<{
  text: string;
  entryCount: number;
  jobId: string;
}> {
  return sendRuntimeRequest({ type: "analysis.getLogs" });
}

export function clearAnalysisLogs(): Promise<{ removed: boolean; jobId?: string }> {
  return sendRuntimeRequest({ type: "analysis.clearLogs" });
}

function terminal(status: AnalysisJob["status"]): boolean {
  return ["complete", "partial", "failed", "cancelled"].includes(status);
}

/** A completed or in-flight report can be safely replayed when the panel opens. */
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

/** A persisted report belongs to the active tab and exact article URL. */
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

function eventIdentity(event: AnalysisEvent): string {
  return JSON.stringify(event);
}

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
  onEvent: (event: AnalysisEvent) => void,
  signal?: AbortSignal,
  preferences?: AnalysisPreferences,
  onStatus?: (status: AnalysisStreamStatus) => void,
  options?: { forceNew?: boolean },
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");

  // The background extracts the active article and authoritatively decides
  // whether an existing report matches its fingerprint. The side panel never
  // reuses a job from tab metadata alone.
  const runtime = await getRuntimeState();
  if (preferences) {
    await updateExtensionPreferences({
      ...runtime.preferences,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
    });
  }

  const job = await sendRuntimeRequest<AnalysisJob>({
    type: "analysis.start",
    ...(options?.forceNew ? { forceNew: true } : {}),
  });
  let deliveredSequence = job.lastEventSequence ?? 0;
  let deliveredRevision = job.revision ?? 0;
  const deliveredKeys = new Set<string>();
  let settled = false;
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((error: Error) => void) | undefined;
  let unsubscribe: () => void = () => undefined;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let abortListenerAttached = false;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const cleanup = () => {
    unsubscribe();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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
    rejectDone?.(new DOMException("Analysis cancelled", "AbortError"));
  };

  const apply = (next: AnalysisJob) => {
    if (next.id !== job.id || settled) return;
    if ((next.revision ?? 0) < deliveredRevision) return;
    deliveredRevision = Math.max(deliveredRevision, next.revision ?? 0);
    deliveredSequence = Math.max(deliveredSequence, next.lastEventSequence ?? 0);
    // The current runtime sends snapshots. The identity set also makes this
    // adapter safe when the runtime switches to sequenced event deltas.
    // `events` is a bounded ring. An index cursor gets stuck at 128 after the
    // first wrap, so replay every retained event and de-duplicate by content.
    for (const event of next.events) {
      const key = eventIdentity(event);
      if (deliveredKeys.has(key)) continue;
      deliveredKeys.add(key);
      onEvent(event);
    }
    if (!terminal(next.status)) return;
    settled = true;
    cleanup();
    if (next.status === "failed") {
      rejectDone?.(new Error(next.error ?? "The article could not be analyzed."));
    } else if (next.status === "cancelled") {
      rejectDone?.(new DOMException("Analysis cancelled", "AbortError"));
    } else {
      resolveDone?.();
    }
  };

  const applyDelta = (message: {
    jobId: string;
    runToken: string | null;
    revision: number;
    sequence: number;
    event: AnalysisEvent;
  }) => {
    if (settled || message.jobId !== job.id) return;
    if (message.runToken !== (job.runToken ?? null)) return;
    // Each accepted runtime mutation advances revision. Equal revisions can
    // be replayed by both a delta and a snapshot; keep the first copy only.
    if (message.revision <= deliveredRevision) return;
    deliveredRevision = message.revision;
    if (message.sequence <= deliveredSequence) return;
    deliveredSequence = message.sequence;
    const key = eventIdentity(message.event);
    if (deliveredKeys.has(key)) return;
    deliveredKeys.add(key);
    onEvent(message.event);
  };

  const subscribedUnsubscribe = subscribeRuntimePush((message) => {
    if (message.type === "analysis.jobChanged") apply(message.job);
    if (message.type === "analysis.eventDelta") applyDelta(message);
  });
  unsubscribe = subscribedUnsubscribe;
  // Be defensive if an adapter ever replays a terminal snapshot while the
  // subscription is being installed.
  if (settled) unsubscribe();
  onStatus?.("connected");
  // A side panel can briefly miss a broadcast while Chrome recreates a
  // service worker. Polling is a cheap reconnect path and also supports
  // replaying an active job after the panel has been closed and reopened.
  let missedPolls = 0;
  if (!settled) {
    pollTimer = setInterval(() => {
      if (settled) return;
      void sendRuntimeRequest<AnalysisJob>({ type: "analysis.getJob", jobId: job.id })
        .then((next) => {
          missedPolls = 0;
          onStatus?.("connected");
          apply(next);
        })
        .catch(() => {
          missedPolls += 1;
          if (missedPolls >= 2) onStatus?.("reconnecting");
        });
    }, 1_500);
  }
  if (!settled && signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    abortListenerAttached = true;
    if (signal.aborted) onAbort();
  }

  try {
    apply(
      await abortable(
        sendRuntimeRequest<AnalysisJob>({ type: "analysis.getJob", jobId: job.id }),
        signal,
      ),
    );
  } catch (error) {
    if (!signal?.aborted) {
      if (!settled) {
        settled = true;
        cleanup();
      }
      throw error;
    }
  }
  return done;
}
