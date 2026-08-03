import type { ArticleDocument } from "@perspectica/contracts";
import type { ArticleIndex } from "@perspectica/contracts/article";
import type { SourceLedgerSnapshot } from "@perspectica/contracts/evidence";
import type { AnalysisPlan } from "@perspectica/contracts/report";
import type { AnalysisBudget, AnalysisArtifacts } from "@perspectica/intelligence";
import type { PipelineTelemetry } from "@perspectica/intelligence";

export type PersistedAnalysisArtifacts = Omit<AnalysisArtifacts, "ledger"> & {
  ledger: SourceLedgerSnapshot;
};

export interface AnalysisArtifactStore {
  set(jobId: string, runToken: string, artifacts: AnalysisArtifacts): Promise<void>;
  get(jobId: string, runToken: string): Promise<PersistedAnalysisArtifacts | null>;
  clear(jobId: string, runToken?: string): Promise<void>;
}

interface ArtifactRecord {
  jobId: string;
  runToken: string;
  expiresAt: number;
  artifacts: PersistedAnalysisArtifacts;
}

interface MemoryRecord {
  expiresAt: number;
  artifacts: PersistedAnalysisArtifacts;
}

const DATABASE_NAME = "perspectica-analysis-artifacts-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "artifacts";

function key(jobId: string, runToken: string): string {
  return `${jobId}:${runToken}`;
}

function persistable(artifacts: AnalysisArtifacts): PersistedAnalysisArtifacts {
  return {
    analysisId: artifacts.analysisId,
    article: structuredClone(artifacts.article),
    index: structuredClone(artifacts.index),
    plan: structuredClone(artifacts.plan),
    budget: structuredClone(artifacts.budget),
    telemetry: structuredClone(artifacts.telemetry),
    ledger: structuredClone(artifacts.ledger.snapshot()),
  };
}

function restoreable(value: PersistedAnalysisArtifacts): PersistedAnalysisArtifacts {
  return {
    analysisId: value.analysisId,
    article: value.article as ArticleDocument,
    index: value.index as ArticleIndex,
    plan: value.plan as AnalysisPlan,
    budget: value.budget as AnalysisBudget,
    telemetry: value.telemetry as PipelineTelemetry,
    ledger: value.ledger as SourceLedgerSnapshot,
  };
}

export class IndexedDbAnalysisArtifactStore implements AnalysisArtifactStore {
  private readonly memory = new Map<string, MemoryRecord>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: ["jobId", "runToken"] });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    return this.dbPromise;
  }

  async set(jobId: string, runToken: string, artifacts: AnalysisArtifacts): Promise<void> {
    const value = persistable(artifacts);
    const expiresAt = Date.now() + 24 * 60 * 60_000;
    for (const cacheKey of this.memory.keys()) {
      if (cacheKey !== key(jobId, runToken)) this.memory.delete(cacheKey);
    }
    this.memory.set(key(jobId, runToken), { expiresAt, artifacts: value });
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({
        jobId,
        runToken,
        expiresAt,
        artifacts: value,
      } satisfies ArtifactRecord);
      const cursorRequest = transaction.objectStore(STORE_NAME).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const record = cursor.value as ArtifactRecord;
        if (record.jobId !== jobId || record.runToken !== runToken) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  }

  async get(jobId: string, runToken: string): Promise<PersistedAnalysisArtifacts | null> {
    const cacheKey = key(jobId, runToken);
    const cached = this.memory.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) return structuredClone(cached.artifacts);
      this.memory.delete(cacheKey);
    }
    const db = await this.open();
    if (!db) return null;
    const record = await new Promise<ArtifactRecord | null>((resolve) => {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get([jobId, runToken]);
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve((request.result as ArtifactRecord | undefined) ?? null);
    });
    if (!record?.artifacts || record.expiresAt <= Date.now()) {
      if (record) {
        await this.clear(jobId, runToken);
      }
      return null;
    }
    const value = restoreable(record.artifacts);
    this.memory.set(cacheKey, { expiresAt: record.expiresAt, artifacts: value });
    return structuredClone(value);
  }

  async clear(jobId: string, runToken?: string): Promise<void> {
    if (runToken) this.memory.delete(key(jobId, runToken));
    else
      for (const cacheKey of this.memory.keys())
        if (cacheKey.startsWith(`${jobId}:`)) this.memory.delete(cacheKey);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      if (runToken) {
        transaction.objectStore(STORE_NAME).delete([jobId, runToken]);
      } else {
        const request = transaction.objectStore(STORE_NAME).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const record = cursor.value as ArtifactRecord;
          if (record.jobId === jobId) cursor.delete();
          cursor.continue();
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  }
}
