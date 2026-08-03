import type { AnalysisEnvelope } from "@perspectica/contracts/events";
import type { AnalysisLogEntry, AnalysisLogInput } from "../runtime/messages";

const DATABASE_NAME = "perspectica-analysis-v2";
const DATABASE_VERSION = 1;
const EVENT_STORE = "events";
const LOG_STORE = "logs";
const MAX_LOG_ENTRIES = 400;

function memoryKey(jobId: string, sequence: number): string {
  return `${jobId}:${sequence}`;
}

export class AnalysisJournal {
  private readonly eventMemory = new Map<string, AnalysisEnvelope>();
  private readonly logMemory = new Map<string, AnalysisLogEntry[]>();
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
      request.onsuccess = () => resolve(request.result);
    });
    return this.dbPromise;
  }

  async appendEvent(envelope: AnalysisEnvelope): Promise<void> {
    const parsed = structuredClone(envelope);
    this.eventMemory.set(memoryKey(envelope.jobId, envelope.sequence), parsed);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(EVENT_STORE, "readwrite");
      tx.objectStore(EVENT_STORE).put(parsed);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not append analysis event."));
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
    return new Promise((resolve) => {
      const values: AnalysisEnvelope[] = [];
      const tx = db.transaction(EVENT_STORE, "readonly");
      const range = IDBKeyRange.bound([jobId, afterSequence + 1], [jobId, Number.MAX_SAFE_INTEGER]);
      const request = tx.objectStore(EVENT_STORE).openCursor(range);
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || values.length >= limit) {
          resolve(values);
          return;
        }
        values.push(cursor.value as AnalysisEnvelope);
        cursor.continue();
      };
    });
  }

  async clearEvents(jobId: string): Promise<void> {
    for (const key of [...this.eventMemory.keys()])
      if (key.startsWith(`${jobId}:`)) this.eventMemory.delete(key);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(EVENT_STORE, "readwrite");
      const request = tx.objectStore(EVENT_STORE).index("job").openCursor(IDBKeyRange.only(jobId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async appendLog(jobId: string, input: AnalysisLogInput): Promise<AnalysisLogEntry> {
    const current = await this.getLogs(jobId);
    const entry: AnalysisLogEntry = { ...input, sequence: (current.at(-1)?.sequence ?? 0) + 1 };
    const next = [...current, entry].slice(-MAX_LOG_ENTRIES);
    this.logMemory.set(jobId, next);
    const db = await this.open();
    if (db) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(LOG_STORE, "readwrite");
        tx.objectStore(LOG_STORE).put({ jobId, ...entry });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
    return entry;
  }

  async getLogs(jobId: string): Promise<AnalysisLogEntry[]> {
    const cached = this.logMemory.get(jobId);
    if (cached) return structuredClone(cached);
    const db = await this.open();
    if (!db) return [];
    const result = await new Promise<AnalysisLogEntry[]>((resolve) => {
      const values: AnalysisLogEntry[] = [];
      const tx = db.transaction(LOG_STORE, "readonly");
      const request = tx.objectStore(LOG_STORE).index("job").openCursor(IDBKeyRange.only(jobId));
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(
            values.sort((left, right) => left.sequence - right.sequence).slice(-MAX_LOG_ENTRIES),
          );
          return;
        }
        const value = cursor.value as { jobId: string } & AnalysisLogEntry;
        values.push(value);
        cursor.continue();
      };
    });
    this.logMemory.set(jobId, result);
    return structuredClone(result);
  }

  async clearLogs(jobId: string): Promise<void> {
    this.logMemory.delete(jobId);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(LOG_STORE, "readwrite");
      const request = tx.objectStore(LOG_STORE).index("job").openCursor(IDBKeyRange.only(jobId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}
