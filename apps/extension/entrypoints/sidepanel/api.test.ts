import type { PipelineEvent } from "@perspectica/contracts/events";
import type { AnalysisPreferences } from "@perspectica/contracts";
import type { AnalysisJob } from "../../src/runtime/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  sendRuntimeRequest: vi.fn(),
  subscribeRuntimePushWithStatus: vi.fn(),
}));

vi.mock("../../src/runtime/client", () => runtime);

import {
  CHATGPT_HOST_ORIGINS,
  isResumableJob,
  isResumableJobForTab,
  requestChatGptHostAccess,
  streamAnalysis,
} from "./api";

const preferences: AnalysisPreferences = { model: "gpt-5.6-luna", reasoningEffort: "medium" };
const emittedAt = "2026-08-02T12:00:00.000Z";

function job(
  status: AnalysisJob["status"] = "analyzing",
  overrides: Partial<AnalysisJob> = {},
): AnalysisJob {
  return {
    id: "job-1",
    tabId: 1,
    tabUrl: "https://example.com/article",
    articleFingerprint: "article-1",
    analysisConfigFingerprint: null,
    status,
    createdAt: emittedAt,
    updatedAt: emittedAt,
    error: null,
    events: [],
    runToken: "run-1",
    revision: 0,
    lastEventSequence: 0,
    ...overrides,
  };
}

function event(type: PipelineEvent["type"], sequence = 1): PipelineEvent {
  if (type === "analysis.completed") {
    return {
      type,
      analysisId: "analysis-1",
      emittedAt,
      data: {
        completedAt: emittedAt,
        durationMs: sequence,
        status: "complete",
        failedSections: [],
        acceptedSources: 1,
        acceptedAssertions: 1,
      },
    };
  }
  if (type === "phase.changed") {
    return {
      type,
      analysisId: "analysis-1",
      emittedAt,
      data: { phase: "retrieving", message: `phase ${sequence}` },
    };
  }
  return {
    type: "metadata.ready",
    analysisId: "analysis-1",
    emittedAt,
    data: {
      title: `Article ${sequence}`,
      author: null,
      publication: "Example News",
      publishedAt: null,
      contentType: "news",
    },
  };
}

function setup(initial: AnalysisJob = job()): {
  emit: (message: unknown) => void;
  status: (value: "connected" | "reconnecting") => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((message: unknown) => void) | undefined;
  let statusListener: ((status: "connected" | "reconnecting") => void) | undefined;
  const unsubscribe = vi.fn();
  runtime.subscribeRuntimePushWithStatus.mockImplementation(
    (
      next: (message: unknown) => void,
      onStatus?: (status: "connected" | "reconnecting") => void,
    ) => {
      listener = next;
      statusListener = onStatus;
      onStatus?.("connected");
      return unsubscribe;
    },
  );
  runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
    switch (request.type) {
      case "runtime.getState":
        return {
          runtimeProtocol: 6,
          auth: {
            status: "authenticated",
            account: null,
            remembered: true,
            models: [],
            error: null,
          },
          preferences: {
            ...preferences,
            mode: "balanced",
            searchProvider: "chatgpt",
            rememberChatGpt: true,
          },
          activeJob: initial,
          hasExaKey: false,
        };
      case "analysis.start":
        return initial;
      case "analysis.getEventsSince":
        return { jobId: initial.id, lastSequence: 0, events: [], complete: false };
      case "analysis.getJob":
        return initial;
      default:
        return { ok: true };
    }
  });
  return {
    emit: (message) => listener?.(message),
    status: (value) => statusListener?.(value),
    unsubscribe,
  };
}

beforeEach(() => {
  runtime.sendRuntimeRequest.mockReset();
  runtime.subscribeRuntimePushWithStatus.mockReset();
});

describe("ChatGPT access and job reuse", () => {
  it("requests only the OpenAI origins needed by the connection", async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", { permissions: { request } });
    await expect(requestChatGptHostAccess()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({ origins: [...CHATGPT_HOST_ORIGINS] });
  });

  it("keeps terminal jobs renderable but does not resume failed or cancelled jobs", () => {
    expect(isResumableJob(job("complete"))).toBe(true);
    expect(isResumableJob(job("partial"))).toBe(true);
    expect(isResumableJob(job("failed"))).toBe(false);
    expect(isResumableJob(job("cancelled"))).toBe(false);
    expect(
      isResumableJobForTab(job("complete"), { id: 1, url: "https://example.com/article#comments" }),
    ).toBe(true);
  });
});

describe("V2 append-only stream replay", () => {
  it("replays journal events after reconnect and ignores duplicate sequences", async () => {
    const initial = job();
    const stream = setup(initial);
    let replayCount = 0;
    runtime.sendRuntimeRequest.mockImplementation(
      async (request: { type: string; lastSequence?: number }) => {
        if (request.type === "runtime.getState")
          return {
            runtimeProtocol: 6,
            auth: {
              status: "authenticated",
              account: null,
              remembered: true,
              models: [],
              error: null,
            },
            preferences: {
              ...preferences,
              mode: "balanced",
              searchProvider: "chatgpt",
              rememberChatGpt: true,
            },
            activeJob: initial,
            hasExaKey: false,
          };
        if (request.type === "analysis.start") return initial;
        if (request.type === "analysis.getEventsSince") {
          replayCount += 1;
          return replayCount === 1
            ? {
                jobId: initial.id,
                lastSequence: 1,
                events: [
                  {
                    jobId: initial.id,
                    runToken: "run-1",
                    sequence: 1,
                    revision: 1,
                    event: event("metadata.ready", 1),
                  },
                ],
                complete: false,
              }
            : {
                jobId: initial.id,
                lastSequence: 2,
                events: [
                  {
                    jobId: initial.id,
                    runToken: "run-1",
                    sequence: 1,
                    revision: 1,
                    event: event("metadata.ready", 1),
                  },
                  {
                    jobId: initial.id,
                    runToken: "run-1",
                    sequence: 2,
                    revision: 2,
                    event: event("phase.changed", 2),
                  },
                ],
                complete: false,
              };
        }
        return initial;
      },
    );
    const received: PipelineEvent[] = [];
    const pending = streamAnalysis(received.push.bind(received), undefined, preferences);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    stream.status("reconnecting");
    stream.status("connected");
    await vi.waitFor(() => expect(received).toHaveLength(2));
    stream.emit({
      type: "analysis.eventDelta",
      jobId: initial.id,
      runToken: "run-1",
      revision: 3,
      sequence: 3,
      event: event("analysis.completed", 3),
    });
    await expect(pending).resolves.toBeUndefined();
    expect(received.map((value) => value.type)).toEqual([
      "metadata.ready",
      "phase.changed",
      "analysis.completed",
    ]);
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
  });

  it("terminates from a replayed completion without waiting for a live delta", async () => {
    const initial = job("complete", { revision: 1, lastEventSequence: 1 });
    const stream = setup(initial);
    runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
      if (request.type === "runtime.getState")
        return {
          runtimeProtocol: 6,
          auth: {
            status: "authenticated",
            account: null,
            remembered: true,
            models: [],
            error: null,
          },
          preferences: {
            ...preferences,
            mode: "balanced",
            searchProvider: "chatgpt",
            rememberChatGpt: true,
          },
          activeJob: initial,
          hasExaKey: false,
        };
      if (request.type === "analysis.start") return initial;
      if (request.type === "analysis.getEventsSince")
        return {
          jobId: initial.id,
          lastSequence: 1,
          events: [
            {
              jobId: initial.id,
              runToken: "run-1",
              sequence: 1,
              revision: 1,
              event: event("analysis.completed"),
            },
          ],
          complete: true,
        };
      return initial;
    });
    const received: PipelineEvent[] = [];
    await expect(
      streamAnalysis(received.push.bind(received), undefined, preferences),
    ).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it("rejects terminal failure and sends one cancellation on abort", async () => {
    const initial = job();
    const stream = setup(initial);
    const pending = streamAnalysis(() => undefined, undefined, preferences);
    await vi.waitFor(() => expect(runtime.subscribeRuntimePushWithStatus).toHaveBeenCalledOnce());
    stream.emit({
      type: "analysis.eventDelta",
      jobId: initial.id,
      runToken: "run-1",
      revision: 1,
      sequence: 1,
      event: {
        type: "analysis.failed",
        analysisId: "analysis-1",
        emittedAt,
        data: { message: "provider unavailable", retryable: true },
      },
    });
    await expect(pending).rejects.toThrow("provider unavailable");

    runtime.sendRuntimeRequest.mockReset();
    const second = setup(job("analyzing", { id: "job-2" }));
    runtime.sendRuntimeRequest.mockImplementation(async (request: { type: string }) => {
      if (request.type === "runtime.getState")
        return {
          runtimeProtocol: 6,
          auth: {
            status: "authenticated",
            account: null,
            remembered: true,
            models: [],
            error: null,
          },
          preferences: {
            ...preferences,
            mode: "balanced",
            searchProvider: "chatgpt",
            rememberChatGpt: true,
          },
          activeJob: null,
          hasExaKey: false,
        };
      if (request.type === "analysis.start") return job("analyzing", { id: "job-2" });
      if (request.type === "analysis.getEventsSince") return new Promise(() => {});
      return { ok: true };
    });
    const controller = new AbortController();
    const aborted = streamAnalysis(() => undefined, controller.signal, preferences);
    await vi.waitFor(() => expect(runtime.subscribeRuntimePushWithStatus).toHaveBeenCalled());
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.sendRuntimeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: "analysis.cancel", jobId: "job-2" }),
    );
    expect(second.unsubscribe).toHaveBeenCalledOnce();
  });
});
