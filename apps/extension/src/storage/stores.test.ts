import { describe, expect, it } from "vitest";
import type { AnalysisJob, AnalysisResumeData } from "../runtime/messages";
import type { JsonStorageArea } from "./areas";
import { JobStore, type AnalysisResumeVault } from "./job-store";
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

class FailJobWriteStorage extends MemoryStorage {
  failNextJobWrite = false;

  override async set<T>(key: string, value: T): Promise<void> {
    if (this.failNextJobWrite && key === "perspectica.jobs.v1.job-1") {
      this.failNextJobWrite = false;
      throw new Error("simulated job write failure");
    }
    await super.set(key, value);
  }
}

class MemoryResumeVault implements AnalysisResumeVault {
  value: { jobId: string; resume: AnalysisResumeData } | undefined;

  async get(jobId: string): Promise<AnalysisResumeData | undefined> {
    return this.value?.jobId === jobId ? structuredClone(this.value.resume) : undefined;
  }

  async set(jobId: string, resume: AnalysisResumeData): Promise<void> {
    this.value = { jobId, resume: structuredClone(resume) };
  }

  async remove(jobId: string): Promise<void> {
    if (this.value?.jobId === jobId) this.value = undefined;
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
      searchProvider: "free",
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

  it("keeps resumable article input out of plaintext extension storage", async () => {
    const storage = new MemoryStorage();
    const resumeVault = new MemoryResumeVault();
    const store = new JobStore(storage, undefined, undefined, undefined, resumeVault);
    const resume: AnalysisResumeData = {
      runToken: "run-job-1",
      request: {
        article: {
          title: "Private article",
          author: null,
          publication: "Example",
          publishedAt: null,
          canonicalUrl: "https://example.com/article",
          contentType: "news",
          paragraphs: [
            { id: "p-1", kind: "paragraph", text: "Sensitive text", index: 0, speaker: null },
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
      searchProvider: "free",
      cacheScope: "free:public",
    };

    await store.set(job("job-1"), resume);
    expect(
      [...storage.values.values()].some((value) =>
        JSON.stringify(value).includes("Sensitive text"),
      ),
    ).toBe(false);
    await expect(store.getResume("job-1")).resolves.toEqual(resume);

    await store.update("job-1", (current) => ({ ...current, status: "cancelled" }));
    await expect(store.getResume("job-1")).resolves.toBeUndefined();
  });

  it("clears the active job and same-job journal, logs, and resume data", async () => {
    const storage = new MemoryStorage();
    const resumeVault = new MemoryResumeVault();
    const store = new JobStore(storage, undefined, undefined, undefined, resumeVault);
    const resume: AnalysisResumeData = {
      runToken: "run-job-1",
      request: {
        article: {
          title: "Private article",
          author: null,
          publication: "Example",
          publishedAt: null,
          canonicalUrl: "https://example.com/article",
          contentType: "news",
          paragraphs: [
            { id: "p-1", kind: "paragraph", text: "Sensitive text", index: 0, speaker: null },
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
      searchProvider: "free",
      cacheScope: "free:public",
    };
    await store.set(job("job-1"), resume);
    await store.appendLog("job-1", {
      timestamp: "2026-07-29T12:00:00.000Z",
      level: "info",
      scope: "test",
      event: "test.event",
      message: "private telemetry",
      payload: null,
    });
    await store.commitEvent({
      jobId: "job-1",
      runToken: "run-job-1",
      sequence: 1,
      event: {
        type: "metadata.ready",
        analysisId: "analysis-1",
        emittedAt: "2026-07-29T12:00:00.000Z",
        data: {
          title: "Private article",
          author: null,
          publication: "Example",
          publishedAt: null,
          contentType: "news",
        },
      },
    });

    await store.clearActiveData();

    await expect(store.getActive()).resolves.toBeUndefined();
    await expect(store.get("job-1")).resolves.toBeUndefined();
    await expect(store.getResume("job-1")).resolves.toBeUndefined();
    await expect(store.getLogs("job-1")).resolves.toEqual([]);
    await expect(store.getEventsSince("job-1", 0)).resolves.toEqual([]);
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
    await store.commitEvent({ jobId: "job-1", runToken: "run-job-1", sequence: 1, event });
    await store.commitEvent({ jobId: "job-1", runToken: "run-job-1", sequence: 2, event });

    await expect(store.getEventsSince("job-1", 1)).resolves.toEqual([
      expect.objectContaining({ sequence: 2, event }),
    ]);
  });

  it("commits event rows before the job cursor and repairs a failed cursor write idempotently", async () => {
    const storage = new FailJobWriteStorage();
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

    storage.failNextJobWrite = true;
    await expect(
      store.commitEvent({
        jobId: "job-1",
        runToken: "run-job-1",
        sequence: 1,
        event,
      }),
    ).rejects.toThrow("simulated job write failure");
    await expect(store.getEventsSince("job-1", 0)).resolves.toHaveLength(1);
    await expect(store.get("job-1")).resolves.toMatchObject({ lastEventSequence: 0 });

    await expect(
      store.commitEvent({
        jobId: "job-1",
        runToken: "run-job-1",
        sequence: 1,
        event,
      }),
    ).resolves.toMatchObject({ accepted: true, job: { lastEventSequence: 1 } });
    await expect(
      store.commitEvent({
        jobId: "job-1",
        runToken: "run-job-1",
        sequence: 1,
        event,
      }),
    ).resolves.toMatchObject({ accepted: false, duplicate: true });
  });

  it("rejects a cursor gap instead of making an unreplayable journal", async () => {
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

    await expect(
      store.commitEvent({
        jobId: "job-1",
        runToken: "run-job-1",
        sequence: 2,
        event,
      }),
    ).resolves.toMatchObject({ accepted: false, gap: true });
    await expect(store.getEventsSince("job-1", 0)).resolves.toEqual([]);
  });

  it("invalidates a legacy terminal job instead of rendering a blank V2 report", async () => {
    const storage = new MemoryStorage();
    storage.values.set("perspectica.jobs.active.v1", "legacy-job");
    storage.values.set("perspectica.jobs.v1.legacy-job", {
      ...job("legacy-job"),
      analysisId: "legacy-analysis",
      status: "complete",
      events: [{ type: "analysis.completed", data: {} }],
      lastEventSequence: 4,
    });
    const store = new JobStore(storage);

    await expect(store.getActive()).resolves.toMatchObject({
      id: "legacy-job",
      status: "failed",
      runToken: null,
      lastEventSequence: 0,
      events: [],
      error: expect.stringContaining("extension update"),
    });
    await expect(store.getResume("legacy-job")).resolves.toBeUndefined();
  });

  it("invalidates a legacy resumable job before dispatch can reuse its cursor", async () => {
    const storage = new MemoryStorage();
    storage.values.set("perspectica.jobs.v1.legacy-job", {
      ...job("legacy-job"),
      status: "analyzing",
      runToken: "legacy-run",
      events: [],
    });
    storage.values.set("perspectica.jobs.resume.v1.legacy-job", {
      runToken: "legacy-run",
      request: {
        article: {
          title: "Legacy",
          author: null,
          publication: null,
          publishedAt: null,
          canonicalUrl: "https://example.com/article",
          contentType: "news",
          paragraphs: [
            { id: "p-1", kind: "paragraph", text: "Legacy article text", index: 0, speaker: null },
          ],
          links: [],
          fingerprint: "fingerprint",
          language: "en",
          extraction: {
            extractorVersion: "dom-v5",
            extractedAt: "2026-07-29T12:00:00.000Z",
            wordCount: 3,
          },
        },
        client: { extensionVersion: "0.1.0" },
        preferences: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      },
      searchProvider: "free",
    });
    const store = new JobStore(storage);

    await expect(store.get("legacy-job")).resolves.toMatchObject({
      status: "failed",
      runToken: null,
      lastEventSequence: 0,
    });
    await expect(store.getResume("legacy-job")).resolves.toBeUndefined();
  });
});
