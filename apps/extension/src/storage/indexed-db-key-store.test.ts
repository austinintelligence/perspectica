import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbCryptoKeyStore } from "./indexed-db-key-store";

describe("IndexedDbCryptoKeyStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for transaction completion after a successful request", async () => {
    let openSuccess: (() => void) | undefined;
    let requestSuccess: (() => void) | undefined;
    let transactionComplete: (() => void) | undefined;
    let transactionAbort: (() => void) | undefined;
    const putRequest = {
      result: "stored",
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    const transaction = {
      error: null,
      objectStore: () => ({ put: () => putRequest }),
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
    };
    const database = {
      close: vi.fn(),
      transaction: () => transaction,
    };
    const openRequest = {
      result: database,
      error: null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    openSuccess = () => openRequest.onsuccess?.();
    requestSuccess = () => putRequest.onsuccess?.();
    transactionComplete = () => transaction.oncomplete?.();
    transactionAbort = () => transaction.onabort?.();
    vi.stubGlobal("indexedDB", { open: vi.fn(() => openRequest) });
    const store = new IndexedDbCryptoKeyStore();

    const pending = store.set("key", {} as CryptoKey);
    openSuccess();
    requestSuccess();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    transactionComplete();
    await expect(pending).resolves.toBeUndefined();
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(transactionAbort).toBeTypeOf("function");
  });
});
