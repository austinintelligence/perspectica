import { AnalysisEnvelopeSchema, type AnalysisEnvelope } from "@perspectica/contracts/events";
import {
  AnalysisLogEntrySchema,
  type AnalysisLogEntry,
  type AnalysisLogInput,
} from "../runtime/messages";
import { IndexedDbCryptoKeyStore, type CryptoKeyStore } from "./indexed-db-key-store";

const DATABASE_NAME = "perspectica-analysis-v2";
const DATABASE_VERSION = 1;
const EVENT_STORE = "events";
const LOG_STORE = "logs";
const MAX_LOG_ENTRIES = 400;
const JOURNAL_KEY_ID = "perspectica-analysis-journal-key-v1";

interface SealedJournalRecord {
  jobId: string;
  sequence: number;
  version: 1;
  iv: string;
  ciphertext: string;
}

function isSealedRecord(value: unknown): value is SealedJournalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SealedJournalRecord>;
  return (
    record.version === 1 &&
    typeof record.jobId === "string" &&
    typeof record.sequence === "number" &&
    typeof record.iv === "string" &&
    typeof record.ciphertext === "string"
  );
}

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

function memoryKey(jobId: string, sequence: number): string {
  return `${jobId}:${sequence}`;
}

export class AnalysisJournal {
  private readonly eventMemory = new Map<string, AnalysisEnvelope>();
  private readonly logMemory = new Map<string, AnalysisLogEntry[]>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly keyStore: CryptoKeyStore = new IndexedDbCryptoKeyStore(),
    private readonly cryptoImplementation: Crypto = globalThis.crypto,
    private readonly runtimeId = typeof chrome === "undefined" ? "perspectica" : chrome.runtime.id,
  ) {}

  private additionalData(kind: "event" | "log", jobId: string, sequence: number): ArrayBuffer {
    return toArrayBuffer(
      new TextEncoder().encode(
        JSON.stringify({ version: 1, runtimeId: this.runtimeId, kind, jobId, sequence }),
      ),
    );
  }

  private async encryptionKey(): Promise<CryptoKey> {
    const existing = await this.keyStore.get(JOURNAL_KEY_ID);
    if (existing) return existing;
    this.keyPromise ??= (async () => {
      const raced = await this.keyStore.get(JOURNAL_KEY_ID);
      if (raced) return raced;
      const key = await this.cryptoImplementation.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await this.keyStore.set(JOURNAL_KEY_ID, key);
      return key;
    })().finally(() => {
      this.keyPromise = null;
    });
    return this.keyPromise;
  }

  private async seal(
    kind: "event" | "log",
    jobId: string,
    sequence: number,
    value: unknown,
  ): Promise<SealedJournalRecord> {
    const key = await this.encryptionKey();
    const iv = this.cryptoImplementation.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await this.cryptoImplementation.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: this.additionalData(kind, jobId, sequence),
      },
      key,
      toArrayBuffer(plaintext),
    );
    return {
      jobId,
      sequence,
      version: 1,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
  }

  private async unseal<T>(kind: "event" | "log", record: SealedJournalRecord): Promise<T> {
    const key = await this.encryptionKey();
    const plaintext = await this.cryptoImplementation.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(decodeBase64(record.iv)),
        additionalData: this.additionalData(kind, record.jobId, record.sequence),
      },
      key,
      toArrayBuffer(decodeBase64(record.ciphertext)),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }

  private async putSealed(store: string, record: SealedJournalRecord): Promise<void> {
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not update analysis journal."));
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
        reject(request.error ?? new Error("Could not open analysis journal."));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EVENT_STORE)) {
          const events = db.createObjectStore(EVENT_STORE, { keyPath: ["jobId", "sequence"] });
          events.createIndex("job", "jobId", { unique: false });
        }
        if (!db.objectStoreNames.contains(LOG_STORE)) {
          const logs = db.createObjectStore(LOG_STORE, { keyPath: ["jobId", "sequence"] });
          logs.createIndex("job", "jobId", { unique: false });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return this.dbPromise;
  }

  async appendEvent(envelope: AnalysisEnvelope): Promise<void> {
    const parsed = structuredClone(envelope);
    const db = await this.open();
    if (!db) {
      this.eventMemory.set(memoryKey(envelope.jobId, envelope.sequence), parsed);
      return;
    }
    const sealed = await this.seal("event", envelope.jobId, envelope.sequence, parsed);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(EVENT_STORE, "readwrite");
      tx.objectStore(EVENT_STORE).put(sealed);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not append analysis event."));
    });
    this.eventMemory.set(memoryKey(envelope.jobId, envelope.sequence), parsed);
  }

  async getEvent(jobId: string, sequence: number): Promise<AnalysisEnvelope | undefined> {
    const cached = this.eventMemory.get(memoryKey(jobId, sequence));
    if (cached) return structuredClone(cached);
    const db = await this.open();
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(EVENT_STORE, "readonly")
        .objectStore(EVENT_STORE)
        .get([jobId, sequence]);
      request.onerror = () => reject(request.error ?? new Error("Could not read analysis event."));
      request.onsuccess = () => {
        const raw = request.result as AnalysisEnvelope | SealedJournalRecord | undefined;
        if (!raw) {
          resolve(undefined);
          return;
        }
        void (async () => {
          const value = AnalysisEnvelopeSchema.parse(
            isSealedRecord(raw) ? await this.unseal("event", raw) : raw,
          );
          if (!isSealedRecord(raw)) {
            await this.putSealed(
              EVENT_STORE,
              await this.seal("event", value.jobId, value.sequence, value),
            );
          }
          this.eventMemory.set(memoryKey(jobId, sequence), structuredClone(value));
          resolve(structuredClone(value));
        })().catch(reject);
      };
    });
  }

  async eventsSince(
    jobId: string,
    afterSequence: number,
    limit = 256,
  ): Promise<AnalysisEnvelope[]> {
    const db = await this.open();
    if (!db) {
      return [...this.eventMemory.values()]
        .filter((event) => event.jobId === jobId && event.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit)
        .map((event) => structuredClone(event));
    }
    const records = await new Promise<Array<AnalysisEnvelope | SealedJournalRecord>>(
      (resolve, reject) => {
        const values: Array<AnalysisEnvelope | SealedJournalRecord> = [];
        const tx = db.transaction(EVENT_STORE, "readonly");
        const range = IDBKeyRange.bound(
          [jobId, afterSequence + 1],
          [jobId, Number.MAX_SAFE_INTEGER],
        );
        const request = tx.objectStore(EVENT_STORE).openCursor(range);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not read analysis events."));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || values.length >= limit) {
            resolve(values);
            return;
          }
          values.push(cursor.value as AnalysisEnvelope | SealedJournalRecord);
          cursor.continue();
        };
      },
    );
    const values = await Promise.all(
      records.map(async (record) =>
        AnalysisEnvelopeSchema.parse(
          isSealedRecord(record) ? await this.unseal("event", record) : record,
        ),
      ),
    );
    await Promise.all(
      records.map(async (record, index) => {
        if (isSealedRecord(record)) return;
        const value = values[index]!;
        await this.putSealed(
          EVENT_STORE,
          await this.seal("event", value.jobId, value.sequence, value),
        );
      }),
    );
    for (const value of values) {
      this.eventMemory.set(memoryKey(value.jobId, value.sequence), structuredClone(value));
    }
    return values;
  }

  async clearEvents(jobId: string): Promise<void> {
    for (const key of [...this.eventMemory.keys()])
      if (key.startsWith(`${jobId}:`)) this.eventMemory.delete(key);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(EVENT_STORE, "readwrite");
      const request = tx.objectStore(EVENT_STORE).index("job").openCursor(IDBKeyRange.only(jobId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear analysis events."));
    });
  }

  async appendLog(jobId: string, input: AnalysisLogInput): Promise<AnalysisLogEntry> {
    const current = await this.getLogs(jobId);
    const entry: AnalysisLogEntry = { ...input, sequence: (current.at(-1)?.sequence ?? 0) + 1 };
    const next = [...current, entry].slice(-MAX_LOG_ENTRIES);
    this.logMemory.set(jobId, next);
    const db = await this.open();
    if (db) {
      await this.putSealed(LOG_STORE, await this.seal("log", jobId, entry.sequence, entry));
    }
    return entry;
  }

  async getLogs(jobId: string): Promise<AnalysisLogEntry[]> {
    const cached = this.logMemory.get(jobId);
    if (cached) return structuredClone(cached);
    const db = await this.open();
    if (!db) return [];
    const result = await new Promise<Array<AnalysisLogEntry | SealedJournalRecord>>(
      (resolve, reject) => {
        const values: Array<AnalysisLogEntry | SealedJournalRecord> = [];
        const tx = db.transaction(LOG_STORE, "readonly");
        const request = tx.objectStore(LOG_STORE).index("job").openCursor(IDBKeyRange.only(jobId));
        request.onerror = () => reject(request.error ?? new Error("Could not read analysis logs."));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(
              values.sort((left, right) => left.sequence - right.sequence).slice(-MAX_LOG_ENTRIES),
            );
            return;
          }
          const value = cursor.value as AnalysisLogEntry | SealedJournalRecord;
          values.push(value);
          cursor.continue();
        };
      },
    );
    const opened = await Promise.all(
      result.map(async (record) =>
        AnalysisLogEntrySchema.parse(
          isSealedRecord(record) ? await this.unseal("log", record) : record,
        ),
      ),
    );
    await Promise.all(
      result.map(async (record, index) => {
        if (isSealedRecord(record)) return;
        const entry = opened[index]!;
        await this.putSealed(LOG_STORE, await this.seal("log", jobId, entry.sequence, entry));
      }),
    );
    this.logMemory.set(jobId, opened);
    return structuredClone(opened);
  }

  async clearLogs(jobId: string): Promise<void> {
    this.logMemory.delete(jobId);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOG_STORE, "readwrite");
      const request = tx.objectStore(LOG_STORE).index("job").openCursor(IDBKeyRange.only(jobId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear analysis logs."));
    });
  }
}
