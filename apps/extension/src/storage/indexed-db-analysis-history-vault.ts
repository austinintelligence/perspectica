import { z } from "zod";
import { IndexedDbCryptoKeyStore, type CryptoKeyStore } from "./indexed-db-key-store";

const DATABASE_NAME = "perspectica-analysis-history-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "history";
const ARCHIVE_ID = "recent-runs";
const HISTORY_KEY_ID = "perspectica-analysis-history-key-v1";
const MAX_HISTORY_BYTES = 25 * 1024 * 1024;

const EncryptedHistoryRecordSchema = z.object({
  id: z.literal(ARCHIVE_ID),
  version: z.literal(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  updatedAt: z.string().datetime({ offset: true }),
});
type EncryptedHistoryRecord = z.infer<typeof EncryptedHistoryRecordSchema>;

export interface LegacyAnalysisHistoryVault {
  readAnalysisHistory<T>(): Promise<T[] | undefined>;
  writeAnalysisHistory<T>(value: T[]): Promise<void>;
  removeAnalysisHistory?(): Promise<void>;
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

/** AES-GCM archive in IndexedDB, avoiding chrome.storage.local's small value quota. */
export class IndexedDbEncryptedAnalysisHistoryVault {
  private memory: unknown[] | undefined;
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly legacy?: LegacyAnalysisHistoryVault,
    private readonly keyStore: CryptoKeyStore = new IndexedDbCryptoKeyStore(),
    private readonly cryptoImplementation: Crypto = globalThis.crypto,
    private readonly runtimeId = typeof chrome === "undefined" ? "perspectica" : chrome.runtime.id,
  ) {}

  private open(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not open encrypted analysis history."));
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return this.dbPromise;
  }

  private additionalData(): ArrayBuffer {
    return toArrayBuffer(
      new TextEncoder().encode(
        JSON.stringify({ version: 1, runtimeId: this.runtimeId, purpose: ARCHIVE_ID }),
      ),
    );
  }

  private async encryptionKey(): Promise<CryptoKey> {
    const existing = await this.keyStore.get(HISTORY_KEY_ID);
    if (existing) return existing;
    this.keyPromise ??= (async () => {
      const raced = await this.keyStore.get(HISTORY_KEY_ID);
      if (raced) return raced;
      const key = await this.cryptoImplementation.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await this.keyStore.set(HISTORY_KEY_ID, key);
      return key;
    })().finally(() => {
      this.keyPromise = null;
    });
    return this.keyPromise;
  }

  async readAnalysisHistory<T>(): Promise<T[] | undefined> {
    const db = await this.open();
    if (!db) return this.memory ? structuredClone(this.memory as T[]) : undefined;
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(ARCHIVE_ID);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read encrypted analysis history."));
      request.onsuccess = () => resolve(request.result);
    });
    if (raw === undefined) {
      const legacy = await this.legacy?.readAnalysisHistory<T>();
      if (legacy) {
        await this.writeAnalysisHistory(legacy);
        await this.legacy?.removeAnalysisHistory?.();
      }
      return legacy;
    }
    const record = EncryptedHistoryRecordSchema.parse(raw);
    const key = await this.encryptionKey();
    const plaintext = await this.cryptoImplementation.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(decodeBase64(record.iv)),
        additionalData: this.additionalData(),
      },
      key,
      toArrayBuffer(decodeBase64(record.ciphertext)),
    );
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as T[];
    if (!Array.isArray(value)) throw new Error("Saved analysis history has an invalid shape.");
    return value;
  }

  async writeAnalysisHistory<T>(value: T[]): Promise<void> {
    if (!Array.isArray(value)) throw new Error("Analysis history must be an array.");
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    if (plaintext.byteLength > MAX_HISTORY_BYTES) {
      throw new Error("Analysis history exceeds the local retention limit.");
    }
    const db = await this.open();
    if (!db) {
      this.memory = structuredClone(value);
      return;
    }
    const key = await this.encryptionKey();
    const iv = this.cryptoImplementation.getRandomValues(new Uint8Array(12));
    const ciphertext = await this.cryptoImplementation.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: this.additionalData() },
      key,
      toArrayBuffer(plaintext),
    );
    const record: EncryptedHistoryRecord = {
      id: ARCHIVE_ID,
      version: 1,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString(),
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not persist encrypted analysis history."));
    });
  }

  async removeAnalysisHistory(): Promise<void> {
    this.memory = undefined;
    const db = await this.open();
    if (db) {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(ARCHIVE_ID);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not clear encrypted analysis history."));
      });
    }
    await this.legacy?.removeAnalysisHistory?.();
  }
}
