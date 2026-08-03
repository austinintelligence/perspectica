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
const memoryCaches = new Map<string, Map<string, CacheRecord<unknown>>>();

export class EvidenceCache implements EvidenceResultCache {
  private readonly memory: Map<string, CacheRecord<unknown>>;
  private readonly normalizedScope: string;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor(scope = "global") {
    this.normalizedScope = scope.trim().slice(0, 256) || "global";
    this.memory = memoryCaches.get(this.normalizedScope) ?? new Map();
    memoryCaches.set(this.normalizedScope, this.memory);
  }

  private scopedKey(key: string): string {
    return `${this.normalizedScope}:${key}`;
  }

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
    const storageKey = this.scopedKey(key);
    const memory = this.memory.get(storageKey);
    if (memory) {
      if (memory.expiresAt > now) return structuredClone(memory.value) as T;
      this.memory.delete(storageKey);
    }
    const db = await this.open();
    if (!db) return null;
    const record = await new Promise<CacheRecord<T> | null>((resolve) => {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(storageKey);
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve((request.result as CacheRecord<T> | undefined) ?? null);
    });
    if (!record || record.expiresAt <= now) {
      if (record) await this.delete(storageKey);
      return null;
    }
    this.memory.set(storageKey, structuredClone(record));
    return structuredClone(record.value);
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const storageKey = this.scopedKey(key);
    const record: CacheRecord<T> = {
      key: storageKey,
      expiresAt: Date.now() + Math.max(1, ttlMs),
      value: structuredClone(value),
    };
    this.memory.set(storageKey, structuredClone(record));
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
    await this.clearScope(this.normalizedScope);
  }

  async clearScope(scope: string): Promise<void> {
    const prefix = `${scope.trim().slice(0, 256) || "global"}:`;
    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix)) this.memory.delete(key);
    }
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const request = tx.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value as CacheRecord<unknown>;
        if (record.key.startsWith(prefix)) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear evidence cache."));
    });
  }

  async clearAll(): Promise<void> {
    for (const memory of memoryCaches.values()) memory.clear();
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear evidence cache."));
    });
  }
}
