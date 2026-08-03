import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonStorageArea } from "./areas";
import { CredentialVault, MissingVaultKeyError } from "./credential-vault";
import type { CryptoKeyStore } from "./indexed-db-key-store";

class MemoryStorage implements JsonStorageArea {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class MemoryKeyStore implements CryptoKeyStore {
  readonly values = new Map<string, CryptoKey>();
  setCalls = 0;

  async get(id: string): Promise<CryptoKey | undefined> {
    return this.values.get(id);
  }

  async set(id: string, key: CryptoKey): Promise<void> {
    this.setCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.values.set(id, key);
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id);
  }
}

describe("CredentialVault", () => {
  it("encrypts remembered ChatGPT and Exa credentials with separate records", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryKeyStore();
    const vault = new CredentialVault(storage, keys, "extension-a");

    await vault.writeChatGpt({
      refreshToken: "refresh-secret",
      accountId: "account-1",
      email: "reader@example.com",
    });
    await vault.writeExa({ apiKey: "exa-secret" });

    expect(await vault.readChatGpt()).toEqual({
      refreshToken: "refresh-secret",
      accountId: "account-1",
      email: "reader@example.com",
    });
    expect(await vault.readExa()).toEqual({ apiKey: "exa-secret" });
    expect(JSON.stringify([...storage.values.values()])).not.toContain("refresh-secret");
    expect(JSON.stringify([...storage.values.values()])).not.toContain("exa-secret");
    expect(storage.values.size).toBe(2);
    expect(keys.values.size).toBe(1);
  });

  it("uses a new IV for every write", async () => {
    const storage = new MemoryStorage();
    const vault = new CredentialVault(storage, new MemoryKeyStore(), "extension-a");

    await vault.writeExa({ apiKey: "same-secret" });
    const first = structuredClone([...storage.values.values()][0]) as { iv: string };
    await vault.writeExa({ apiKey: "same-secret" });
    const second = structuredClone([...storage.values.values()][0]) as { iv: string };

    expect(second.iv).not.toBe(first.iv);
  });

  it("coalesces concurrent first-key creation", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryKeyStore();
    const vault = new CredentialVault(storage, keys, "extension-a");

    await Promise.all([
      vault.writeExa({ apiKey: "exa-a" }),
      vault.writeChatGpt({ refreshToken: "refresh", accountId: "account-1" }),
    ]);

    expect(keys.setCalls).toBe(1);
    expect(await vault.readExa()).toEqual({ apiKey: "exa-a" });
    expect(await vault.readChatGpt()).toMatchObject({ refreshToken: "refresh" });
  });

  it("binds ciphertext to the extension runtime and credential purpose", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryKeyStore();
    const firstVault = new CredentialVault(storage, keys, "extension-a");
    await firstVault.writeExa({ apiKey: "exa-secret" });

    const otherRuntime = new CredentialVault(storage, keys, "extension-b");
    await expect(otherRuntime.readExa()).rejects.toThrow("integrity check");

    const envelope = storage.values.get("perspectica.vault.v1.exa");
    storage.values.set("perspectica.vault.v1.chatgpt", envelope);
    await expect(firstVault.read("chatgpt", z.object({ apiKey: z.string() }))).rejects.toThrow(
      "integrity check",
    );
  });

  it("fails closed when encrypted data outlives its non-exportable key", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryKeyStore();
    const vault = new CredentialVault(storage, keys, "extension-a");
    await vault.writeExa({ apiKey: "exa-secret" });
    keys.values.clear();

    await expect(vault.readExa()).rejects.toBeInstanceOf(MissingVaultKeyError);
  });

  it("clears both encrypted records and the encryption key", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryKeyStore();
    const vault = new CredentialVault(storage, keys, "extension-a");
    await vault.writeExa({ apiKey: "exa-secret" });
    await vault.writeChatGpt({ refreshToken: "refresh", accountId: "account" });

    await vault.clear();

    expect(await vault.has("exa")).toBe(false);
    expect(await vault.has("chatgpt")).toBe(false);
    expect(keys.values.size).toBe(0);
  });

  it("encrypts bounded analysis history separately from provider credentials", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryKeyStore();
    const vault = new CredentialVault(storage, keys, "extension-a");
    const history = [{ jobId: "job-1", articleText: "private article text" }];

    await vault.writeAnalysisHistory(history);

    await expect(vault.readAnalysisHistory<typeof history>()).resolves.toEqual(history);
    expect(JSON.stringify([...storage.values.values()])).not.toContain("private article text");
    await vault.remove("analysis");
    await expect(vault.readAnalysisHistory()).resolves.toBeUndefined();
  });
});
