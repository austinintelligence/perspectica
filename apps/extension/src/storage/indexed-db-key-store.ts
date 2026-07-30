const DATABASE_NAME = "perspectica-credential-vault";
const DATABASE_VERSION = 1;
const OBJECT_STORE = "keys";

export interface CryptoKeyStore {
  get(id: string): Promise<CryptoKey | undefined>;
  set(id: string, key: CryptoKey): Promise<void>;
  remove(id: string): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open credential vault."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE)) {
        database.createObjectStore(OBJECT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE, mode);
      const request = operation(transaction.objectStore(OBJECT_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Credential vault failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Credential vault transaction was aborted."));
    });
  } finally {
    database.close();
  }
}

export class IndexedDbCryptoKeyStore implements CryptoKeyStore {
  async get(id: string): Promise<CryptoKey | undefined> {
    const value = await transact<unknown>("readonly", (store) => store.get(id));
    return typeof CryptoKey !== "undefined" && value instanceof CryptoKey ? value : undefined;
  }

  async set(id: string, key: CryptoKey): Promise<void> {
    await transact<IDBValidKey>("readwrite", (store) => store.put(key, id));
  }

  async remove(id: string): Promise<void> {
    await transact<undefined>("readwrite", (store) => store.delete(id));
  }
}
