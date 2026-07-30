import { z } from "zod";
import type { JsonStorageArea } from "./areas";
import type { CryptoKeyStore } from "./indexed-db-key-store";

const VAULT_VERSION = 1;
const KEY_ID = "perspectica-vault-key-v1";
const ENVELOPE_PREFIX = "perspectica.vault.v1.";

// A vault can be reached concurrently by several startup paths (for example,
// session restoration and the first analysis).  Keep key creation coalesced
// per key store so two callers cannot generate different keys and race to
// persist them under the same id.
const keyCreationInFlight = new WeakMap<object, Promise<CryptoKey>>();

const EncryptedEnvelopeSchema = z.object({
  version: z.literal(VAULT_VERSION),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
});
type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

const ChatGptCredentialSchema = z.object({
  refreshToken: z.string().min(1),
  accountId: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
});
export type ChatGptCredential = z.infer<typeof ChatGptCredentialSchema>;

const ExaCredentialSchema = z.object({
  apiKey: z.string().trim().min(1),
});
export type ExaCredential = z.infer<typeof ExaCredentialSchema>;

export type VaultPurpose = "chatgpt" | "exa";

export class MissingVaultKeyError extends Error {
  constructor() {
    super("The saved connection cannot be opened. Reconnect this device.");
    this.name = "MissingVaultKeyError";
  }
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

function storageKey(purpose: VaultPurpose): string {
  return `${ENVELOPE_PREFIX}${purpose}`;
}

export class CredentialVault {
  constructor(
    private readonly storage: JsonStorageArea,
    private readonly keyStore: CryptoKeyStore,
    private readonly runtimeId: string,
    private readonly cryptoImplementation: Crypto = globalThis.crypto,
  ) {}

  private additionalData(purpose: VaultPurpose): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ version: VAULT_VERSION, runtimeId: this.runtimeId, purpose }),
    );
  }

  private async readKey(): Promise<CryptoKey | undefined> {
    return this.keyStore.get(KEY_ID);
  }

  private async getOrCreateKey(): Promise<CryptoKey> {
    const existing = await this.readKey();
    if (existing) return existing;
    const inFlight = keyCreationInFlight.get(this.keyStore);
    if (inFlight) return inFlight;

    const creation = (async () => {
      // Another runtime sharing this key store may have won the race while we
      // were awaiting the first read.
      const raced = await this.readKey();
      if (raced) return raced;
      const created = await this.cryptoImplementation.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await this.keyStore.set(KEY_ID, created);
      return created;
    })();
    keyCreationInFlight.set(this.keyStore, creation);
    try {
      return await creation;
    } finally {
      if (keyCreationInFlight.get(this.keyStore) === creation) {
        keyCreationInFlight.delete(this.keyStore);
      }
    }
  }

  async has(purpose: VaultPurpose): Promise<boolean> {
    return Boolean(await this.storage.get(storageKey(purpose)));
  }

  async write<T>(purpose: VaultPurpose, value: T): Promise<void> {
    const key = await this.getOrCreateKey();
    const iv = this.cryptoImplementation.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await this.cryptoImplementation.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(this.additionalData(purpose)),
      },
      key,
      toArrayBuffer(plaintext),
    );
    const envelope: EncryptedEnvelope = {
      version: VAULT_VERSION,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      createdAt: new Date().toISOString(),
    };
    await this.storage.set(storageKey(purpose), envelope);
  }

  async read<T>(purpose: VaultPurpose, schema: z.ZodType<T>): Promise<T | undefined> {
    const raw = await this.storage.get(storageKey(purpose));
    if (raw === undefined) return undefined;
    const envelope = EncryptedEnvelopeSchema.parse(raw);
    const key = await this.readKey();
    if (!key) throw new MissingVaultKeyError();
    try {
      const plaintext = await this.cryptoImplementation.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(decodeBase64(envelope.iv)),
          additionalData: toArrayBuffer(this.additionalData(purpose)),
        },
        key,
        toArrayBuffer(decodeBase64(envelope.ciphertext)),
      );
      return schema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      throw new Error("The saved connection failed its integrity check.", { cause: error });
    }
  }

  readChatGpt(): Promise<ChatGptCredential | undefined> {
    return this.read("chatgpt", ChatGptCredentialSchema);
  }

  writeChatGpt(value: ChatGptCredential): Promise<void> {
    return this.write("chatgpt", ChatGptCredentialSchema.parse(value));
  }

  readExa(): Promise<ExaCredential | undefined> {
    return this.read("exa", ExaCredentialSchema);
  }

  writeExa(value: ExaCredential): Promise<void> {
    return this.write("exa", ExaCredentialSchema.parse(value));
  }

  async remove(purpose: VaultPurpose): Promise<void> {
    await this.storage.remove(storageKey(purpose));
  }

  async clear(): Promise<void> {
    await Promise.all([this.remove("chatgpt"), this.remove("exa")]);
    await this.keyStore.remove(KEY_ID);
  }
}
