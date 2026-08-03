import { describe, expect, it } from "vitest";
import type { AnalysisJob } from "../runtime/messages";
import type { JsonStorageArea } from "./areas";
import { JobStore } from "./job-store";
import { PreferencesStore } from "./preferences-store";

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

function job(id: string): AnalysisJob {
  return {
    id,
    tabId: 1,
    tabUrl: "https://example.com/article",
    articleFingerprint: "fingerprint",
    analysisConfigFingerprint: "analysis-config-v1:gpt-5.6-luna:medium:exa",
    status: "analyzing",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    error: null,
    events: [],
    runToken: `run-${id}`,
    revision: 0,
    lastEventSequence: 0,
  };
}

describe("extension stores", () => {
  it("returns safe default preferences when storage is missing or invalid", async () => {
    const storage = new MemoryStorage();
    const store = new PreferencesStore(storage);

    await expect(store.get()).resolves.toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      mode: "balanced",
      searchProvider: "exa",
      rememberChatGpt: true,
    });

    storage.values.set("perspectica.preferences.v2", { model: "not-a-model" });
    await expect(store.get()).resolves.toMatchObject({ model: "gpt-5.6-luna" });
  });

  it("keeps only the current analysis job", async () => {
    const storage = new MemoryStorage();
    const store = new JobStore(storage);
    await store.set(job("job-1"));
    await store.set(job("job-2"));

    await expect(store.getActive()).resolves.toMatchObject({ id: "job-2" });
    await expect(store.get("job-1")).resolves.toBeUndefined();
    await expect(store.get("job-2")).resolves.toMatchObject({ id: "job-2" });
  });

  it("serializes concurrent telemetry writes and removes logs with an old job", async () => {
    const storage = new MemoryStorage();
    const store = new JobStore(storage);
    await store.set(job("job-1"));

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.appendLog("job-1", {
          timestamp: `2026-07-29T12:00:0${index}.000Z`,
          level: "info",
          scope: "test",
          event: "test.event",
          message: `entry ${index + 1}`,
          payload: null,
        }),
      ),
    );

    await expect(store.getLogs("job-1")).resolves.toMatchObject([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
      { sequence: 4 },
      { sequence: 5 },
      { sequence: 6 },
    ]);

    await store.set(job("job-2"));
    await expect(store.getLogs("job-1")).resolves.toEqual([]);
  });

  it("serializes concurrent job revisions and persists resumable input", async () => {
    const storage = new MemoryStorage();
    const store = new JobStore(storage);
    await store.set(job("job-1"), {
      runToken: "run-job-1",
      request: {
        article: {
          title: "Example",
          author: null,
          publication: "Example",
          publishedAt: null,
          canonicalUrl: "https://example.com/article",
          contentType: "news",
          paragraphs: [
            { id: "p-1", kind: "paragraph", text: "Article text", index: 0, speaker: null },
          ],
          links: [],
          fingerprint: "fingerprint",
          language: "en",
          extraction: {
            extractorVersion: "test",
            extractedAt: "2026-07-29T12:00:00.000Z",
            wordCount: 2,
          },
        },
        client: { extensionVersion: "0.1.0" },
        preferences: { model: "gpt-5.6-luna", reasoningEffort: "medium", mode: "balanced" },
      },
      searchProvider: "exa",
    });

    await Promise.all(
      Array.from({ length: 6 }, () =>
        store.update("job-1", (current) => ({
          ...current,
          revision: current.revision + 1,
          lastEventSequence: current.lastEventSequence + 1,
        })),
      ),
    );

    await expect(store.get("job-1")).resolves.toMatchObject({
      revision: 6,
      lastEventSequence: 6,
    });
    await expect(store.getResume("job-1")).resolves.toMatchObject({
      runToken: "run-job-1",
      searchProvider: "exa",
    });

    await store.update("job-1", (current) => ({
      ...current,
      status: "cancelled",
      revision: current.revision + 1,
    }));
    await expect(store.getResume("job-1")).resolves.toBeUndefined();
  });

  it("persists and replays append-only event envelopes by sequence", async () => {
    const storage = new MemoryStorage();
    const store = new JobStore(storage);
    await store.set(job("job-1"));
    const event = {
      type: "metadata.ready" as const,
      analysisId: "analysis-1",
      emittedAt: "2026-07-29T12:00:00.000Z",
      data: {
        title: "Example",
        author: null,
        publication: "Example News",
        publishedAt: null,
        contentType: "news" as const,
      },
    };
    await store.appendEvent({
      protocol: 2,
      jobId: "job-1",
      runToken: "run-job-1",
      sequence: 1,
      revision: 1,
      event,
    });
    await store.appendEvent({
      protocol: 2,
      jobId: "job-1",
      runToken: "run-job-1",
      sequence: 2,
      revision: 2,
      event,
    });

    await expect(store.getEventsSince("job-1", 1)).resolves.toEqual([
      expect.objectContaining({ sequence: 2, event }),
    ]);
  });
});
