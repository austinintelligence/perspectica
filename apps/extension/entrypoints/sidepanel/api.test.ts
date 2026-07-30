import type { AnalysisEvent } from "@perspectica/contracts";
import type { AnalysisPreferences } from "@perspectica/contracts";
import type { AnalysisJob } from "../../src/runtime/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  sendRuntimeRequest: vi.fn(),
  subscribeRuntimePush: vi.fn(),
}));

vi.mock("../../src/runtime/client", () => runtime);

import {
  CHATGPT_HOST_ORIGINS,
  isResumableJob,
  isResumableJobForTab,
  requestChatGptHostAccess,
  streamAnalysis,
} from "./api";

function job(status: AnalysisJob["status"]): AnalysisJob {
  return {
    id: "job-1",
    tabId: 1,
    tabUrl: "https://example.com/article",
    articleFingerprint: "article-1",
    analysisConfigFingerprint: null,
    status,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:01.000Z",
    error: null,
    events: [],
    runToken: null,
    revision: 0,
    lastEventSequence: 0,
  };
}

const preferences: AnalysisPreferences = {
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
};

const emittedAt = "2026-07-29T00:00:00.000Z";

function event(
  analysisId: string,
  index: number,
  type: AnalysisEvent["type"] = "metadata.ready",
): AnalysisEvent {
  if (type === "analysis.completed") {
    return {
      type,
      analysisId,
      emittedAt: new Date(Date.parse(emittedAt) + index).toISOString(),
      data: {
        completedAt: emittedAt,
        durationMs: index,
        status: "complete",
        failedSections: [],
      },
    };
  }
  return {
    type,
    analysisId,
    emittedAt: new Date(Date.parse(emittedAt) + index).toISOString(),
    data: {
      title: `Article ${index}`,
      author: null,
      publication: "Example News",
      publishedAt: null,
      contentType: "news",
    },
  } as AnalysisEvent;
}

function analysisJob(
  status: AnalysisJob["status"],
  overrides: Partial<AnalysisJob> = {},
): AnalysisJob {
  return {
    ...job(status),
    runToken: "run-1",
    revision: 0,
    lastEventSequence: 0,
    ...overrides,
  };
}

function setActiveTab(tab: { id: number; url: string }): void {
  (globalThis as unknown as { chrome?: { tabs?: { query: () => Promise<unknown[]> } } }).chrome = {
    tabs: { query: vi.fn(async () => [tab]) },
  };
}

function setupRuntime(initial: AnalysisJob | null): {
  emit: (message: unknown) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((message: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  runtime.subscribeRuntimePush.mockImplementation((next: (message: unknown) => void) => {
    listener = next;
    return unsubscribe;
  });
  runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
    if (request.type === "runtime.getState") {
      return {
        runtimeProtocol: 1,
        auth: {
          status: "authenticated",
          account: null,
          remembered: true,
          models: [],
          error: null,
        },
        preferences: { ...preferences, searchProvider: "chatgpt", rememberChatGpt: true },
        activeJob: initial,
        hasExaKey: false,
      };
    }
    if (request.type === "analysis.getJob") return initial;
    if (request.type === "analysis.start") {
      return initial ?? analysisJob("analyzing", { id: "new-job", tabId: 7 });
    }
    return { ok: true };
  });
  return {
    emit: (message: unknown) => listener?.(message),
    unsubscribe,
  };
}

beforeEach(() => {
  runtime.sendRuntimeRequest.mockReset();
  runtime.subscribeRuntimePush.mockReset();
  setActiveTab({ id: 1, url: "https://example.com/article" });
});

describe("analysis stream resume policy", () => {
  it("resumes active and already-renderable reports", () => {
    expect(isResumableJob(job("queued"))).toBe(true);
    expect(isResumableJob(job("analyzing"))).toBe(true);
    expect(isResumableJob(job("complete"))).toBe(true);
    expect(isResumableJob(job("partial"))).toBe(true);
  });

  it("does not loop a failed or cancelled job", () => {
    expect(isResumableJob(job("failed"))).toBe(false);
    expect(isResumableJob(job("cancelled"))).toBe(false);
    expect(isResumableJob(null)).toBe(false);
  });

  it("only replays a report for the same active article tab", () => {
    const current = job("complete");
    expect(isResumableJobForTab(current, { id: 1, url: current.tabUrl })).toBe(true);
    expect(isResumableJobForTab(current, { id: 2, url: current.tabUrl })).toBe(false);
    expect(isResumableJobForTab(current, { id: 1, url: "https://example.com/other" })).toBe(false);
    expect(isResumableJobForTab(current, { id: 1, url: `${current.tabUrl}#comments` })).toBe(true);
  });
});

describe("ChatGPT host access", () => {
  it("requests only the two OpenAI origins required by authentication and inference", async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", { permissions: { request } });

    await expect(requestChatGptHostAccess()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({ origins: [...CHATGPT_HOST_ORIGINS] });
  });

  it("stops before authentication when the user declines host access", async () => {
    vi.stubGlobal("chrome", { permissions: { request: vi.fn(async () => false) } });

    await expect(requestChatGptHostAccess()).rejects.toThrow("ChatGPT access was not granted");
  });
});

describe("streamAnalysis runtime replay", () => {
  it("replays a wrapped 128-event snapshot instead of using a stale index cursor", async () => {
    const firstEvents = Array.from({ length: 128 }, (_, index) => event("analysis-1", index));
    const wrappedEvent = event("analysis-1", 128);
    const initial = analysisJob("analyzing", {
      id: "job-1",
      tabId: 1,
      revision: 128,
      lastEventSequence: 128,
      events: firstEvents,
    });
    const wrapped = {
      ...initial,
      status: "complete" as const,
      revision: 129,
      lastEventSequence: 129,
      events: [...firstEvents.slice(1), wrappedEvent],
    };
    const stream = setupRuntime(initial);
    runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
      if (request.type === "runtime.getState") {
        return {
          runtimeProtocol: 1,
          auth: {
            status: "authenticated",
            account: null,
            remembered: true,
            models: [],
            error: null,
          },
          preferences: { ...preferences, searchProvider: "chatgpt", rememberChatGpt: true },
          activeJob: initial,
          hasExaKey: false,
        };
      }
      if (request.type === "analysis.getJob") return initial;
      if (request.type === "analysis.start") return initial;
      return { ok: true };
    });

    const received: AnalysisEvent[] = [];
    const pending = streamAnalysis(received.push.bind(received), undefined, preferences);
    await vi.waitFor(() => expect(runtime.subscribeRuntimePush).toHaveBeenCalledOnce());
    stream.emit({ type: "analysis.jobChanged", job: wrapped });
    await pending;

    expect(received).toHaveLength(129);
    expect(received.at(-1)).toEqual(wrappedEvent);
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
  });

  it("deduplicates repeated deltas and ignores stale revision, wrong job, and wrong token", async () => {
    const initial = analysisJob("analyzing", { id: "job-1", tabId: 1 });
    const stream = setupRuntime(initial);
    const received: AnalysisEvent[] = [];
    const pending = streamAnalysis(received.push.bind(received), undefined, preferences);
    await vi.waitFor(() => expect(runtime.subscribeRuntimePush).toHaveBeenCalledOnce());
    const next = event("analysis-1", 1);
    stream.emit({
      type: "analysis.eventDelta",
      jobId: "job-1",
      runToken: "run-1",
      revision: 1,
      sequence: 1,
      event: next,
    });
    stream.emit({
      type: "analysis.eventDelta",
      jobId: "other-job",
      runToken: "run-1",
      revision: 1,
      sequence: 1,
      event: next,
    });
    stream.emit({
      type: "analysis.eventDelta",
      jobId: "job-1",
      runToken: "wrong-token",
      revision: 2,
      sequence: 2,
      event: event("analysis-1", 2),
    });
    stream.emit({
      type: "analysis.eventDelta",
      jobId: "job-1",
      runToken: "run-1",
      revision: 0,
      sequence: 3,
      event: event("analysis-1", 3),
    });
    stream.emit({
      type: "analysis.eventDelta",
      jobId: "job-1",
      runToken: "run-1",
      revision: 2,
      sequence: 2,
      event: next,
    });
    stream.emit({
      type: "analysis.jobChanged",
      job: { ...initial, status: "complete", revision: 3, lastEventSequence: 3, events: [] },
    });

    await expect(pending).resolves.toBeUndefined();
    expect(received).toEqual([next]);
  });

  it("rejects failed and cancelled terminal snapshots and cleans the subscription", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      runtime.subscribeRuntimePush.mockClear();
      const initial = analysisJob("analyzing", { id: `job-${status}`, tabId: 1 });
      const stream = setupRuntime(initial);
      const pending = streamAnalysis(() => undefined, undefined, preferences);
      await vi.waitFor(() => expect(runtime.subscribeRuntimePush).toHaveBeenCalledOnce());
      stream.emit({
        type: "analysis.jobChanged",
        job: {
          ...initial,
          status,
          revision: 1,
          lastEventSequence: 1,
          error: status === "failed" ? "provider unavailable" : null,
        },
      });
      await expect(pending).rejects.toMatchObject({
        name: status === "cancelled" ? "AbortError" : "Error",
      });
      expect(stream.unsubscribe).toHaveBeenCalledOnce();
    }
  });

  it("cleans the subscription and polling timer when the first job replay fails", async () => {
    vi.useFakeTimers();
    try {
      const initial = analysisJob("analyzing", { id: "job-replay-failure", tabId: 1 });
      const stream = setupRuntime(initial);
      runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
        if (request.type === "runtime.getState") {
          return {
            runtimeProtocol: 1,
            auth: {
              status: "authenticated",
              account: null,
              remembered: true,
              models: [],
              error: null,
            },
            preferences: { ...preferences, searchProvider: "chatgpt", rememberChatGpt: true },
            activeJob: initial,
            hasExaKey: false,
          };
        }
        if (request.type === "analysis.start") return initial;
        if (request.type === "analysis.getJob") throw new Error("runtime replay unavailable");
        return { ok: true };
      });

      await expect(streamAnalysis(() => undefined)).rejects.toThrow("runtime replay unavailable");
      expect(stream.unsubscribe).toHaveBeenCalledOnce();
      expect(
        runtime.sendRuntimeRequest.mock.calls.filter(
          ([request]) => request.type === "analysis.getJob",
        ),
      ).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(4_500);
      expect(
        runtime.sendRuntimeRequest.mock.calls.filter(
          ([request]) => request.type === "analysis.getJob",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends one cancel request and cleans up when the caller aborts", async () => {
    const initial = analysisJob("analyzing", { id: "job-1", tabId: 1 });
    const stream = setupRuntime(initial);
    const controller = new AbortController();
    let resolveInitial!: (job: AnalysisJob) => void;
    runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
      if (request.type === "runtime.getState") {
        return {
          runtimeProtocol: 1,
          auth: {
            status: "authenticated",
            account: null,
            remembered: true,
            models: [],
            error: null,
          },
          preferences: { ...preferences, searchProvider: "chatgpt", rememberChatGpt: true },
          activeJob: null,
          hasExaKey: false,
        };
      }
      if (request.type === "preferences.update") return request;
      if (request.type === "analysis.start") return initial;
      if (request.type === "analysis.getJob") {
        return new Promise<AnalysisJob>((resolve) => {
          resolveInitial = resolve;
        });
      }
      return { ok: true };
    });
    const pending = streamAnalysis(() => undefined, controller.signal, preferences);
    await vi.waitFor(() => expect(runtime.subscribeRuntimePush).toHaveBeenCalledOnce());
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    resolveInitial(initial);
    await assertion;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      runtime.sendRuntimeRequest.mock.calls.filter(
        ([request]) => request.type === "analysis.cancel",
      ),
    ).toHaveLength(1);
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
  });

  it("starts a new run for a different active tab and can force a retry on the same tab", async () => {
    const finished = analysisJob("complete", {
      id: "old-job",
      tabId: 1,
      tabUrl: "https://example.com/article",
    });
    setupRuntime(finished);
    const received: AnalysisEvent[] = [];
    runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
      if (request.type === "runtime.getState") {
        return {
          runtimeProtocol: 1,
          auth: {
            status: "authenticated",
            account: null,
            remembered: true,
            models: [],
            error: null,
          },
          preferences: { ...preferences, searchProvider: "chatgpt", rememberChatGpt: true },
          activeJob: finished,
          hasExaKey: false,
        };
      }
      if (request.type === "preferences.update") return request;
      if (request.type === "analysis.start")
        return analysisJob("complete", { id: "new-job", tabId: 2 });
      if (request.type === "analysis.getJob")
        return analysisJob("complete", { id: "new-job", tabId: 2 });
      return { ok: true };
    });
    setActiveTab({ id: 2, url: "https://example.com/other" });
    await expect(
      streamAnalysis(received.push.bind(received), undefined, preferences),
    ).resolves.toBeUndefined();
    expect(runtime.sendRuntimeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: "analysis.start" }),
    );

    runtime.sendRuntimeRequest.mockClear();
    setActiveTab({ id: 1, url: "https://example.com/article" });
    await expect(
      streamAnalysis(() => undefined, undefined, preferences, undefined, { forceNew: true }),
    ).resolves.toBeUndefined();
    expect(runtime.sendRuntimeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: "analysis.start", forceNew: true }),
    );
  });
});
