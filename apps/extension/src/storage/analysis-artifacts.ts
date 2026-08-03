import { ArticleDocumentSchema } from "@perspectica/contracts";
import { ArticleIndexSchema, type ArticleIndex } from "@perspectica/contracts/article";
import {
  SourceLedgerSnapshotSchema,
  type SourceLedgerSnapshot,
} from "@perspectica/contracts/evidence";
import { AnalysisPlanSchema, type AnalysisPlan } from "@perspectica/contracts/report";
import type { ArticleDocument } from "@perspectica/contracts";
import type { AnalysisBudget, AnalysisArtifacts } from "@perspectica/intelligence";
import type { PipelineTelemetry } from "@perspectica/intelligence";
import { IndexedDbCryptoKeyStore, type CryptoKeyStore } from "./indexed-db-key-store";

export type PersistedAnalysisArtifacts = Omit<AnalysisArtifacts, "ledger"> & {
  ledger: SourceLedgerSnapshot;
};

export interface AnalysisArtifactStore {
  set(jobId: string, runToken: string, artifacts: AnalysisArtifacts): Promise<void>;
  get(jobId: string, runToken: string): Promise<PersistedAnalysisArtifacts | null>;
  clear(jobId: string, runToken?: string): Promise<void>;
  clearAll(): Promise<void>;
}

interface LegacyArtifactRecord {
  jobId: string;
  runToken: string;
  expiresAt: number;
  artifacts: PersistedAnalysisArtifacts;
}

interface EncryptedArtifactRecord {
  jobId: string;
  runToken: string;
  expiresAt: number;
  version: 1;
  iv: string;
  ciphertext: string;
}

type ArtifactRecord = LegacyArtifactRecord | EncryptedArtifactRecord;

interface MemoryRecord {
  expiresAt: number;
  artifacts: PersistedAnalysisArtifacts;
}

const DATABASE_NAME = "perspectica-analysis-artifacts-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "artifacts";
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const ARTIFACT_KEY_ID = "perspectica-analysis-artifact-key-v1";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function key(jobId: string, runToken: string): string {
  return `${jobId}:${runToken}`;
}

function persistable(artifacts: AnalysisArtifacts): PersistedAnalysisArtifacts {
  const value = {
    analysisId: artifacts.analysisId,
    article: structuredClone(artifacts.article),
    index: structuredClone(artifacts.index),
    plan: structuredClone(artifacts.plan),
    budget: structuredClone(artifacts.budget),
    telemetry: structuredClone(artifacts.telemetry),
    ledger: structuredClone(artifacts.ledger.snapshot()),
  };
  if (JSON.stringify(value).length > MAX_ARTIFACT_BYTES) {
    throw new Error("The analysis artifact is too large to retain safely.");
  }
  return value;
}

function restoreable(value: PersistedAnalysisArtifacts): PersistedAnalysisArtifacts {
  return {
    analysisId: value.analysisId,
    article: ArticleDocumentSchema.parse(value.article),
    index: ArticleIndexSchema.parse(value.index),
    plan: AnalysisPlanSchema.parse(value.plan),
    budget: value.budget as AnalysisBudget,
    telemetry: value.telemetry as PipelineTelemetry,
    ledger: SourceLedgerSnapshotSchema.parse(value.ledger),
  };
}

export class IndexedDbAnalysisArtifactStore implements AnalysisArtifactStore {
  private readonly memory = new Map<string, MemoryRecord>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly keyStore: CryptoKeyStore = new IndexedDbCryptoKeyStore(),
    private readonly cryptoImplementation: Crypto = globalThis.crypto,
    private readonly runtimeId = typeof chrome === "undefined" ? "perspectica" : chrome.runtime.id,
  ) {}

  private additionalData(jobId: string, runToken: string): ArrayBuffer {
    return toArrayBuffer(
      new TextEncoder().encode(
        JSON.stringify({ version: 1, runtimeId: this.runtimeId, jobId, runToken }),
      ),
    );
  }

  private async encryptionKey(): Promise<CryptoKey> {
    const existing = await this.keyStore.get(ARTIFACT_KEY_ID);
    if (existing) return existing;
    this.keyPromise ??= (async () => {
      const raced = await this.keyStore.get(ARTIFACT_KEY_ID);
      if (raced) return raced;
      const key = await this.cryptoImplementation.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await this.keyStore.set(ARTIFACT_KEY_ID, key);
      return key;
    })().finally(() => {
      this.keyPromise = null;
    });
    return this.keyPromise;
  }

  private async seal(
    jobId: string,
    runToken: string,
    artifacts: PersistedAnalysisArtifacts,
  ): Promise<Pick<EncryptedArtifactRecord, "version" | "iv" | "ciphertext">> {
    const key = await this.encryptionKey();
    const iv = this.cryptoImplementation.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(artifacts));
    const ciphertext = await this.cryptoImplementation.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: this.additionalData(jobId, runToken),
      },
      key,
      toArrayBuffer(plaintext),
    );
    return {
      version: 1,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
  }

  private async openRecord(record: EncryptedArtifactRecord): Promise<PersistedAnalysisArtifacts> {
    const key = await this.encryptionKey();
    const plaintext = await this.cryptoImplementation.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(decodeBase64(record.iv)),
        additionalData: this.additionalData(record.jobId, record.runToken),
      },
      key,
      toArrayBuffer(decodeBase64(record.ciphertext)),
    );
    return restoreable(
      JSON.parse(new TextDecoder().decode(plaintext)) as PersistedAnalysisArtifacts,
    );
  }

  private async rewriteLegacyRecord(
    jobId: string,
    runToken: string,
    expiresAt: number,
    artifacts: PersistedAnalysisArtifacts,
  ): Promise<void> {
    const db = await this.open();
    if (!db) return;
    const encrypted = await this.seal(jobId, runToken, artifacts);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({
        jobId,
        runToken,
        expiresAt,
        ...encrypted,
      } satisfies EncryptedArtifactRecord);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not migrate analysis artifacts."));
    });
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not open analysis artifacts."));
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: ["jobId", "runToken"] });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
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
    const encrypted = await this.seal(jobId, runToken, value);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({
        jobId,
        runToken,
        expiresAt,
        ...encrypted,
      } satisfies EncryptedArtifactRecord);
      const cursorRequest = transaction.objectStore(STORE_NAME).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const record = cursor.value as ArtifactRecord;
        if (record.jobId !== jobId || record.runToken !== runToken) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not persist analysis artifacts."));
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
    const record = await new Promise<ArtifactRecord | null>((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get([jobId, runToken]);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read analysis artifacts."));
      request.onsuccess = () => resolve((request.result as ArtifactRecord | undefined) ?? null);
    });
    if (!record || record.expiresAt <= Date.now()) {
      if (record) {
        await this.clear(jobId, runToken);
      }
      return null;
    }
    const value =
      "artifacts" in record ? restoreable(record.artifacts) : await this.openRecord(record);
    this.memory.set(cacheKey, { expiresAt: record.expiresAt, artifacts: value });
    if ("artifacts" in record) {
      await this.rewriteLegacyRecord(jobId, runToken, record.expiresAt, value);
    }
    return structuredClone(value);
  }

  async clear(jobId: string, runToken?: string): Promise<void> {
    if (runToken) this.memory.delete(key(jobId, runToken));
    else
      for (const cacheKey of this.memory.keys())
        if (cacheKey.startsWith(`${jobId}:`)) this.memory.delete(cacheKey);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
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
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not clear analysis artifacts."));
    });
  }

  async clearAll(): Promise<void> {
    this.memory.clear();
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not clear analysis artifacts."));
    });
  }
}
