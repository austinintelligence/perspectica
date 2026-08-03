import { describe, expect, it } from "vitest";
import type { AnalysisEnvelope } from "@perspectica/contracts/events";
import type { AnalysisJob } from "../runtime/messages";
import { EncryptedAnalysisHistoryStore, type AnalysisHistoryVault } from "./analysis-history";

class MemoryHistoryVault implements AnalysisHistoryVault {
  value: unknown[] | undefined;

  async readAnalysisHistory<T>(): Promise<T[] | undefined> {
    return structuredClone(this.value) as T[] | undefined;
  }

  async writeAnalysisHistory<T>(value: T[]): Promise<void> {
    this.value = structuredClone(value) as unknown[];
  }
}

function job(id: string, updatedAt = new Date().toISOString()): AnalysisJob {
  return {
    id,
    tabId: 1,
    tabUrl: "https://example.com/article",
    articleFingerprint: `fingerprint-${id}`,
    analysisConfigFingerprint: "analysis-config-v2",
    status: "complete",
    createdAt: updatedAt,
    updatedAt,
    error: null,
    events: [],
    runToken: `run-${id}`,
    revision: 1,
    lastEventSequence: 1,
  };
}

const event = {
  protocol: 2,
  jobId: "job-1",
  runToken: "run-job-1",
  sequence: 1,
  revision: 1,
  event: {
    type: "metadata.ready",
    analysisId: "analysis-1",
    emittedAt: "2026-08-03T00:00:00.000Z",
    data: {
      title: "Example",
      author: null,
      publication: null,
      publishedAt: null,
      contentType: "news",
    },
  },
} as AnalysisEnvelope;

describe("EncryptedAnalysisHistoryStore", () => {
  it("retains at most ten recent terminal runs", async () => {
    const vault = new MemoryHistoryVault();
    const store = new EncryptedAnalysisHistoryStore(vault);
    for (let index = 0; index < 12; index += 1) {
      await store.retain(job(`job-${index}`), [event]);
    }

    await expect(store.get()).resolves.toHaveLength(10);
  });

  it("drops expired history and can clear the encrypted archive", async () => {
    const vault = new MemoryHistoryVault();
    const store = new EncryptedAnalysisHistoryStore(vault);
    await store.retain(job("current"), [event]);
    vault.value = [
      {
        job: job("expired", new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString()),
        events: [event],
        savedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
      },
      ...(vault.value ?? []),
    ];

    await expect(store.get()).resolves.toHaveLength(1);
    await store.clear();
    await expect(store.get()).resolves.toEqual([]);
  });
});
