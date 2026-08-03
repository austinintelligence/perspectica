export interface EvidenceResultCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  clear(): Promise<void>;
}

interface CacheRecord<T> {
  key: string;
  expiresAt: number;
  value: T;
}

const DATABASE_NAME = "perspectica-evidence-cache-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "results";

export class EvidenceCache implements EvidenceResultCache {
  private readonly memory = new Map<string, CacheRecord<unknown>>();
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
          request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    return this.dbPromise;
  }

  async get<T>(key: string): Promise<T | null> {
    const now = Date.now();
    if (typeof indexedDB === "undefined") {
      const memory = this.memory.get(key);
      if (memory) {
        if (memory.expiresAt > now) return structuredClone(memory.value) as T;
        this.memory.delete(key);
      }
    }
    const db = await this.open();
    if (!db) return null;
    const record = await new Promise<CacheRecord<T> | null>((resolve) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve((request.result as CacheRecord<T> | undefined) ?? null);
    });
    if (!record || record.expiresAt <= now) {
      if (record) await this.delete(key);
      return null;
    }
    this.memory.set(key, structuredClone(record));
    return structuredClone(record.value);
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const record: CacheRecord<T> = {
      key,
      expiresAt: Date.now() + Math.max(1, ttlMs),
      value: structuredClone(value),
    };
    this.memory.set(key, structuredClone(record));
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  private async delete(key: string): Promise<void> {
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async clear(): Promise<void> {
    this.memory.clear();
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}
