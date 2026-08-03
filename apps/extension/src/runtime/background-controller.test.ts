import { PipelineEventSchema, type PipelineEvent } from "@perspectica/contracts/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonStorageArea } from "../storage/areas";
import { JobStore } from "../storage/job-store";
import type { AnalysisJob, ExtensionResponse, InternalRequest } from "./messages";
import { PERSPECTICA_RUNTIME_PROTOCOL } from "./messages";
import { BackgroundController } from "./background-controller";

class MemoryStorage implements JsonStorageArea {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

interface ChromeTestContext {
  local: MemoryStorage;
  session: MemoryStorage;
  sendMessage: ReturnType<typeof vi.fn>;
}

function installChrome(): ChromeTestContext {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const sendMessage = vi.fn(async () => undefined);
  const runtime = {
    id: "perspectica-test-extension",
    getURL: (path: string) => `chrome-extension://perspectica-test-extension/${path}`,
    sendMessage,
    getContexts: vi.fn(async () => []),
    onMessage: { addListener: vi.fn() },
    onConnect: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
  };
  const chromeMock = {
    runtime,
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: await local.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          await Promise.all(Object.entries(values).map(([key, value]) => local.set(key, value)));
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const value of Array.isArray(key) ? key : [key]) await local.remove(value);
        }),
        setAccessLevel: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: await session.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          await Promise.all(Object.entries(values).map(([key, value]) => session.set(key, value)));
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const value of Array.isArray(key) ? key : [key]) await session.remove(value);
        }),
        setAccessLevel: vi.fn(async () => undefined),
      },
    },
    offscreen: {
      hasDocument: vi.fn(async () => true),
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
      Reason: { WORKERS: "WORKERS" },
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
  } as unknown as typeof chrome;
  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = chromeMock;
  return { local, session, sendMessage };
}

function job(status: AnalysisJob["status"], overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: "job-1",
    tabId: 1,
    tabUrl: "https://example.com/article",
    articleFingerprint: "article-1",
    analysisConfigFingerprint: "analysis-config-v1:gpt-5.6-luna:medium:exa",
    status,
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    error: null,
    events: [],
    runToken: "run-1",
    revision: 0,
    lastEventSequence: 0,
    ...overrides,
  };
}

function metadataEvent(index: number, analysisId = "analysis-1"): PipelineEvent {
  const emittedAt = new Date(Date.parse("2026-07-29T12:00:00.000Z") + index * 1_000).toISOString();
  return PipelineEventSchema.parse({
    type: "metadata.ready",
    analysisId,
    emittedAt,
    data: {
      title: `Article ${index}`,
      author: null,
      publication: "Example News",
      publishedAt: null,
      contentType: "news",
    },
  });
}

function completedEvent(status: "complete" | "partial" = "complete"): PipelineEvent {
  return PipelineEventSchema.parse({
    type: "analysis.completed",
    analysisId: "analysis-1",
    emittedAt: "2026-07-29T12:01:00.000Z",
    data: {
      completedAt: "2026-07-29T12:01:00.000Z",
      durationMs: 60_000,
      status,
      failedSections: status === "partial" ? ["bias"] : [],
      acceptedSources: status === "partial" ? 1 : 2,
      acceptedAssertions: status === "partial" ? 1 : 2,
    },
  });
}

function sender(path: string, id = "perspectica-test-extension") {
  return { id, url: `chrome-extension://${id}/${path}` } as chrome.runtime.MessageSender;
}

function dispatch(
  controller: BackgroundController,
  request: unknown,
  requestSender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    const keepAlive = controller.onMessage(request, requestSender, resolve);
    if (!keepAlive) return;
  });
}

async function putJob(context: ChromeTestContext, value: AnalysisJob): Promise<JobStore> {
  const storage = new (class implements JsonStorageArea {
    async get<T>(key: string): Promise<T | undefined> {
      return context.local.get<T>(key);
    }
    async set<T>(key: string, item: T): Promise<void> {
      return context.local.set(key, item);
    }
    async remove(key: string): Promise<void> {
      return context.local.remove(key);
    }
  })();
  const store = new JobStore(storage);
  await store.set(value);
  return store;
}

describe("BackgroundController runtime protocol", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts trusted side-panel requests and rejects untrusted senders", async () => {
    const context = installChrome();
    const controller = new BackgroundController();
    const trusted = await dispatch(
      controller,
      { type: "runtime.getState", requestId: "trusted" },
      sender("sidepanel.html"),
    );
    expect(trusted).toMatchObject({ ok: true, requestId: "trusted" });

    const external = await dispatch(
      controller,
      { type: "runtime.getState", requestId: "external" },
      sender("sidepanel.html", "different-extension"),
    );
    expect(external).toMatchObject({ ok: false, code: "forbidden", requestId: "external" });
    expect(context.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen.analysis.start" }),
    );
  });

  it("tests a candidate Exa key without persisting it", async () => {
    installChrome();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })),
    );
    const controller = new BackgroundController();

    await expect(
      dispatch(
        controller,
        {
          type: "providers.testExaKey",
          requestId: "test-exa-key",
          apiKey: "candidate-key",
        },
        sender("sidepanel.html"),
      ),
    ).resolves.toMatchObject({ ok: true, data: { available: true } });
    await expect(controller.getRuntimeState()).resolves.toMatchObject({ hasExaKey: false });
  });

  it("accepts valid offscreen events, ignores stale ownership/sequence, and closes the terminal job", async () => {
    const context = installChrome();
    const controller = new BackgroundController();
    const jobs = await putJob(context, job("analyzing"));
    const offscreen = sender("offscreen.html");
    const base = {
      type: "internal.analysis.event" as const,
      requestId: "event-1",
      jobId: "job-1",
      runToken: "run-1",
      sequence: 1,
      event: metadataEvent(1),
    } satisfies InternalRequest;

    await expect(dispatch(controller, base, offscreen)).resolves.toMatchObject({
      ok: true,
      data: { accepted: true, revision: 1 },
    });
    await expect(
      dispatch(controller, { ...base, requestId: "stale-sequence", sequence: 1 }, offscreen),
    ).resolves.toMatchObject({ ok: true, data: { ignored: true } });
    await expect(
      dispatch(
        controller,
        { ...base, requestId: "stale-token", runToken: "other-run", sequence: 2 },
        offscreen,
      ),
    ).resolves.toMatchObject({ ok: true, data: { ignored: true } });

    const completed = {
      ...base,
      requestId: "event-completed",
      sequence: 2,
      event: completedEvent(),
    } satisfies InternalRequest;
    await expect(dispatch(controller, completed, offscreen)).resolves.toMatchObject({
      ok: true,
      data: { accepted: true, revision: 2 },
    });

    await expect(
      dispatch(
        controller,
        { ...base, requestId: "late", sequence: 3, event: metadataEvent(3) },
        offscreen,
      ),
    ).resolves.toMatchObject({ ok: true, data: { ignored: true } });
    await expect(jobs.get("job-1")).resolves.toMatchObject({
      status: "complete",
      revision: 2,
      lastEventSequence: 2,
      events: [],
    });
    await expect(
      dispatch(
        controller,
        { type: "analysis.getEventsSince", requestId: "events-1", jobId: "job-1", lastSequence: 0 },
        sender("sidepanel.html"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        events: [
          expect.objectContaining({ sequence: 1, event: base.event }),
          expect.objectContaining({ sequence: 2, event: completed.event }),
        ],
      },
    });
    expect(context.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "analysis.eventDelta", sequence: 1 }),
    );
    expect(context.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "analysis.eventDelta", sequence: 2 }),
    );
  });

  it("keeps the event journal out of the job snapshot and does not resume terminal jobs", async () => {
    const context = installChrome();
    const controller = new BackgroundController();
    const initial = job("analyzing");
    const jobs = await putJob(context, initial);
    const offscreen = sender("offscreen.html");
    for (let index = 1; index <= 130; index += 1) {
      const response = await dispatch(
        controller,
        {
          type: "internal.analysis.event",
          requestId: `event-${index}`,
          jobId: initial.id,
          runToken: initial.runToken,
          sequence: index,
          event: metadataEvent(index),
        },
        offscreen,
      );
      expect(response).toMatchObject({ ok: true, data: { accepted: true } });
    }
    const persisted = await jobs.get(initial.id);
    expect(persisted?.events).toHaveLength(0);
    expect(persisted?.lastEventSequence).toBe(130);
    await expect(
      dispatch(
        controller,
        {
          type: "analysis.getEventsSince",
          requestId: "events-2",
          jobId: initial.id,
          lastSequence: 128,
        },
        sender("sidepanel.html"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        events: expect.arrayContaining([
          expect.objectContaining({ sequence: 129 }),
          expect.objectContaining({ sequence: 130 }),
        ]),
      },
    });

    context.sendMessage.mockClear();
    await controller.resumeActiveJob();
    expect(context.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen.analysis.start" }),
    );
  });

  it("does not resurrect a cancelled job when a late failure arrives", async () => {
    const context = installChrome();
    const controller = new BackgroundController();
    const jobs = await putJob(
      context,
      job("cancelled", { error: null, revision: 1, lastEventSequence: 1 }),
    );
    const response = await dispatch(
      controller,
      {
        type: "internal.analysis.failed",
        requestId: "late-failure",
        jobId: "job-1",
        runToken: "run-1",
        sequence: 2,
        error: "late provider failure",
      },
      sender("offscreen.html"),
    );
    expect(response).toMatchObject({ ok: true, data: { accepted: false } });
    await expect(jobs.get("job-1")).resolves.toMatchObject({
      status: "cancelled",
      revision: 1,
      lastEventSequence: 1,
      error: null,
    });
    expect(context.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "analysis.jobChanged" }),
    );
  });

  it("does not dispatch an already-terminal job during service-worker resume", async () => {
    const context = installChrome();
    const controller = new BackgroundController();
    await putJob(context, job("partial", { revision: 5, lastEventSequence: 5 }));
    context.sendMessage.mockClear();

    await controller.resumeActiveJob();

    expect(context.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects untrusted offscreen senders before mutating job state", async () => {
    const context = installChrome();
    const controller = new BackgroundController();
    const jobs = await putJob(context, job("analyzing"));
    const request = {
      type: "internal.analysis.event",
      requestId: "untrusted-event",
      jobId: "job-1",
      runToken: "run-1",
      sequence: 1,
      event: metadataEvent(1),
    } satisfies InternalRequest;

    const response = await dispatch(controller, request, sender("offscreen.html", "other-id"));

    expect(response).toMatchObject({ ok: false, code: "forbidden" });
    await expect(jobs.get("job-1")).resolves.toMatchObject({
      status: "analyzing",
      revision: 0,
      lastEventSequence: 0,
      events: [],
    });
    expect(context.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "analysis.eventDelta" }),
    );
  });

  it("does not treat a protocol mismatch as a valid runtime command", () => {
    expect(PERSPECTICA_RUNTIME_PROTOCOL).toBeGreaterThan(0);
  });
});
