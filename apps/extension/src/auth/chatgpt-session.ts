import {
  exchangeDeviceAuthorization,
  listCodexModels,
  parseUser,
  pollDeviceCode,
  refreshTokens,
  requestDeviceCode,
  resolveConfig,
  type ChatGPTTokens,
  type DeviceCode,
} from "@opencoredev/loginwithchatgpt-core";
import { z } from "zod";
import {
  AuthStateSchema,
  DeviceAuthorizationSchema,
  type AuthState,
  type DeviceAuthorization,
  type PublicAccount,
} from "../runtime/messages";
import type { JsonStorageArea } from "../storage/areas";
import type { CredentialVault } from "../storage/credential-vault";

const SESSION_KEY = "perspectica.auth.session.v1";
const PENDING_KEY = "perspectica.auth.pending.v1";
const MODELS_KEY = "perspectica.auth.models.v1";
const REFRESH_SKEW_MS = 2 * 60_000;
const PERSPECTICA_MODELS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.4"] as const;
const ALLOWED_DEVICE_VERIFICATION_HOSTS = new Set(["auth.openai.com"]);

const SessionRecordSchema = z.object({
  accessToken: z.string().min(1),
  account: z.object({
    accountId: z.string().min(1),
    email: z.string().email().optional(),
    name: z.string().min(1).optional(),
    plan: z.string().min(1).optional(),
  }),
  expiresAt: z.number().int().positive().optional(),
  remembered: z.boolean(),
});
type SessionRecord = z.infer<typeof SessionRecordSchema>;

const PendingRecordSchema = z.object({
  deviceAuthId: z.string().min(1),
  userCode: z.string().min(1),
  verificationUrl: z.string().url().refine(isSafeDeviceVerificationUrl, {
    message: "ChatGPT returned an untrusted verification URL.",
  }),
  interval: z.number().positive(),
  expiresAt: z.number().int().positive(),
  remember: z.boolean(),
});
type PendingRecord = z.infer<typeof PendingRecordSchema>;

const ModelListSchema = z.array(z.string().trim().min(1).max(200)).max(100);

function accountFromTokens(tokens: ChatGPTTokens): PublicAccount {
  const parsed = parseUser(tokens.idToken);
  const accountId = parsed?.accountId ?? tokens.accountId;
  if (!accountId) {
    throw new Error("ChatGPT did not return an account identifier. Sign in again.");
  }
  return {
    accountId,
    ...(parsed?.email ? { email: parsed.email } : {}),
    ...(parsed?.name ? { name: parsed.name } : {}),
    ...(parsed?.plan ? { plan: parsed.plan } : {}),
  };
}

function isSafeDeviceVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_DEVICE_VERIFICATION_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function publicDevice(device: DeviceCode): DeviceAuthorization {
  if (!isSafeDeviceVerificationUrl(device.verificationUrl)) {
    throw new Error("ChatGPT returned an untrusted device verification URL.");
  }
  return DeviceAuthorizationSchema.parse({
    userCode: device.userCode,
    verificationUrl: device.verificationUrl,
    expiresAt: device.expiresAt,
    intervalMs: Math.max(1_000, device.interval * 1_000),
  });
}

function pendingToDevice(pending: PendingRecord): DeviceCode {
  return {
    deviceAuthId: pending.deviceAuthId,
    userCode: pending.userCode,
    verificationUrl: pending.verificationUrl,
    interval: pending.interval,
    expiresAt: pending.expiresAt,
  };
}

export class ChatGptSessionManager {
  private readonly config = resolveConfig();
  private restoreInFlight: Promise<SessionRecord | undefined> | null = null;
  private restoreInFlightEpoch: number | null = null;
  private freshTokensInFlight: Promise<ChatGPTTokens> | null = null;
  private freshTokensInFlightEpoch: number | null = null;
  // Vault writes and removals must retain call order. In particular, a
  // disconnect must wait behind an already-started token rotation before it
  // removes the credential; otherwise that write can finish after disconnect
  // and silently recreate the remembered session.
  private vaultMutationBarrier: Promise<void> = Promise.resolve();
  // Refresh tokens are deliberately memory-only for non-remembered sessions.
  // Remembered sessions additionally store the token in the encrypted vault.
  private transientRefreshToken: string | null = null;
  private authEpoch = 0;

  constructor(
    private readonly sessionStorage: JsonStorageArea,
    private readonly localStorage: JsonStorageArea,
    private readonly vault: CredentialVault,
  ) {}

  private cancelledError(): DOMException {
    return new DOMException("Authentication operation cancelled.", "AbortError");
  }

  private isCurrent(epoch: number): boolean {
    return epoch === this.authEpoch;
  }

  private assertCurrent(epoch: number): void {
    if (!this.isCurrent(epoch)) throw this.cancelledError();
  }

  private beginOperation(): number {
    this.authEpoch += 1;
    return this.authEpoch;
  }

  private queueVaultMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.vaultMutationBarrier.then(mutation, mutation);
    this.vaultMutationBarrier = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private writeRememberedCredential(
    credential: Parameters<CredentialVault["writeChatGpt"]>[0],
    epoch: number,
  ): Promise<void> {
    this.assertCurrent(epoch);
    return this.queueVaultMutation(async () => {
      this.assertCurrent(epoch);
      await this.vault.writeChatGpt(credential);
      this.assertCurrent(epoch);
    });
  }

  private removeRememberedCredential(epoch: number): Promise<void> {
    this.assertCurrent(epoch);
    return this.queueVaultMutation(async () => {
      this.assertCurrent(epoch);
      await this.vault.remove("chatgpt");
      this.assertCurrent(epoch);
    });
  }

  private async readSession(epoch = this.authEpoch): Promise<SessionRecord | undefined> {
    const raw = await this.sessionStorage.get<unknown>(SESSION_KEY);
    const parsed = SessionRecordSchema.safeParse(raw);
    // Migrate the pre-vault format, which persisted refreshToken in session
    // storage.  The sanitized record is written back before it can be read by
    // another runtime path.
    if (parsed.success && raw && typeof raw === "object" && "refreshToken" in raw) {
      this.assertCurrent(epoch);
      await this.sessionStorage.set(SESSION_KEY, parsed.data);
      this.assertCurrent(epoch);
    }
    return parsed.success ? parsed.data : undefined;
  }

  private async writeSession(session: SessionRecord, epoch = this.authEpoch): Promise<void> {
    this.assertCurrent(epoch);
    await this.sessionStorage.set(SESSION_KEY, SessionRecordSchema.parse(session));
    this.assertCurrent(epoch);
  }

  private async readPending(): Promise<PendingRecord | undefined> {
    const parsed = PendingRecordSchema.safeParse(await this.sessionStorage.get(PENDING_KEY));
    return parsed.success ? parsed.data : undefined;
  }

  private async readModels(): Promise<string[]> {
    const parsed = ModelListSchema.safeParse(await this.localStorage.get(MODELS_KEY));
    return parsed.success ? parsed.data : [];
  }

  private async writeModels(models: string[], epoch = this.authEpoch): Promise<string[]> {
    const deduplicated = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    const parsed = ModelListSchema.parse(deduplicated);
    this.assertCurrent(epoch);
    await this.localStorage.set(MODELS_KEY, parsed);
    this.assertCurrent(epoch);
    return parsed;
  }

  async begin(remember: boolean): Promise<DeviceAuthorization> {
    const epoch = this.beginOperation();
    const device = await requestDeviceCode(this.config);
    this.assertCurrent(epoch);
    // Validate before persisting pending state so an issuer/configuration
    // cannot smuggle an arbitrary navigation target into the side panel.
    publicDevice(device);
    this.assertCurrent(epoch);
    await this.sessionStorage.set(PENDING_KEY, {
      ...device,
      remember,
    } satisfies PendingRecord);
    this.assertCurrent(epoch);
    return publicDevice(device);
  }

  async pendingAuthorization(): Promise<DeviceAuthorization | null> {
    const pending = await this.readPending();
    if (!pending || pending.expiresAt <= Date.now()) return null;
    return publicDevice(pendingToDevice(pending));
  }

  async poll(): Promise<{ status: "pending" } | { status: "authenticated"; state: AuthState }> {
    const epoch = this.authEpoch;
    const pending = await this.readPending();
    this.assertCurrent(epoch);
    if (!pending || pending.expiresAt <= Date.now()) {
      await this.sessionStorage.remove(PENDING_KEY);
      this.assertCurrent(epoch);
      throw new Error("The sign-in code expired. Start ChatGPT sign-in again.");
    }
    const result = await pollDeviceCode(this.config, pendingToDevice(pending));
    this.assertCurrent(epoch);
    if (result.status === "pending") return result;

    const tokens = await exchangeDeviceAuthorization(this.config, result);
    this.assertCurrent(epoch);
    const account = accountFromTokens(tokens);
    if (!tokens.refreshToken) {
      throw new Error("ChatGPT did not return a refreshable session. Start sign-in again.");
    }
    const session: SessionRecord = {
      accessToken: tokens.accessToken,
      account,
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      remembered: pending.remember,
    };
    this.transientRefreshToken = tokens.refreshToken;
    if (pending.remember) {
      await this.writeRememberedCredential(
        {
          refreshToken: tokens.refreshToken,
          ...account,
        },
        epoch,
      );
    } else {
      await this.removeRememberedCredential(epoch);
    }
    await this.writeSession(session, epoch);
    await this.sessionStorage.remove(PENDING_KEY);
    this.assertCurrent(epoch);
    const models = await this.discoverModels().catch((error) => {
      if (!this.isCurrent(epoch)) throw error;
      return [];
    });
    this.assertCurrent(epoch);
    return {
      status: "authenticated",
      state: AuthStateSchema.parse({
        status: "authenticated",
        account,
        remembered: pending.remember,
        models,
        error: null,
      }),
    };
  }

  private async restoreRememberedOnce(epoch: number): Promise<SessionRecord | undefined> {
    const saved = await this.vault.readChatGpt();
    this.assertCurrent(epoch);
    if (!saved) return undefined;
    const refreshed = await refreshTokens(this.config, saved.refreshToken);
    this.assertCurrent(epoch);
    const refreshToken = refreshed.refreshToken ?? saved.refreshToken;
    this.transientRefreshToken = refreshToken;
    const session: SessionRecord = {
      accessToken: refreshed.accessToken,
      account: {
        accountId: refreshed.accountId ?? saved.accountId,
        ...(saved.email ? { email: saved.email } : {}),
        ...(saved.name ? { name: saved.name } : {}),
        ...(saved.plan ? { plan: saved.plan } : {}),
      },
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      remembered: true,
    };
    await this.writeSession(session, epoch);
    if (refreshToken !== saved.refreshToken) {
      await this.writeRememberedCredential({ ...saved, refreshToken }, epoch);
    }
    return session;
  }

  private restoreRemembered(): Promise<SessionRecord | undefined> {
    const epoch = this.authEpoch;
    if (this.restoreInFlight && this.restoreInFlightEpoch === epoch) return this.restoreInFlight;
    let operation: Promise<SessionRecord | undefined>;
    operation = this.restoreRememberedOnce(epoch).finally(() => {
      if (this.restoreInFlight === operation) {
        this.restoreInFlight = null;
        this.restoreInFlightEpoch = null;
      }
    });
    this.restoreInFlight = operation;
    this.restoreInFlightEpoch = epoch;
    return this.restoreInFlight;
  }

  private async refreshSessionTokens(epoch: number): Promise<ChatGPTTokens> {
    let session = await this.readSession(epoch);
    this.assertCurrent(epoch);
    if (!session) session = await this.restoreRemembered();
    this.assertCurrent(epoch);
    if (!session) throw new Error("Connect ChatGPT before analyzing an article.");

    const expiresSoon =
      typeof session.expiresAt === "number" && session.expiresAt <= Date.now() + REFRESH_SKEW_MS;
    if (expiresSoon) {
      const refreshToken =
        this.transientRefreshToken ??
        (session.remembered ? (await this.vault.readChatGpt())?.refreshToken : undefined);
      this.assertCurrent(epoch);
      if (!refreshToken) {
        await this.sessionStorage.remove(SESSION_KEY);
        this.assertCurrent(epoch);
        throw new Error("Your ChatGPT session expired. Connect ChatGPT again.");
      }
      const refreshed = await refreshTokens(this.config, refreshToken);
      this.assertCurrent(epoch);
      const rotatedRefreshToken = refreshed.refreshToken ?? refreshToken;
      this.transientRefreshToken = rotatedRefreshToken;
      session = {
        ...session,
        accessToken: refreshed.accessToken,
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      };
      await this.writeSession(session, epoch);
      if (session.remembered) {
        const saved = await this.vault.readChatGpt();
        this.assertCurrent(epoch);
        await this.writeRememberedCredential(
          {
            refreshToken: rotatedRefreshToken,
            accountId: session.account.accountId,
            ...(saved?.email ? { email: saved.email } : {}),
            ...(saved?.name ? { name: saved.name } : {}),
            ...(saved?.plan ? { plan: saved.plan } : {}),
          },
          epoch,
        );
      }
    }

    return {
      accessToken: session.accessToken,
      accountId: session.account.accountId,
      expiresAt: session.expiresAt,
    };
  }

  getFreshTokens(): Promise<ChatGPTTokens> {
    const epoch = this.authEpoch;
    if (this.freshTokensInFlight && this.freshTokensInFlightEpoch === epoch) {
      return this.freshTokensInFlight;
    }
    let operation: Promise<ChatGPTTokens>;
    operation = this.refreshSessionTokens(epoch).finally(() => {
      if (this.freshTokensInFlight === operation) {
        this.freshTokensInFlight = null;
        this.freshTokensInFlightEpoch = null;
      }
    });
    this.freshTokensInFlight = operation;
    this.freshTokensInFlightEpoch = epoch;
    return this.freshTokensInFlight;
  }

  async discoverModels(): Promise<string[]> {
    const epoch = this.authEpoch;
    const tokens = await this.getFreshTokens();
    this.assertCurrent(epoch);
    if (!tokens.accountId) throw new Error("The ChatGPT session has no account identifier.");
    const models = await listCodexModels({
      config: this.config,
      getAuth: () => ({
        accessToken: tokens.accessToken,
        accountId: tokens.accountId!,
      }),
    });
    // Newly accepted Codex models may work before they appear in the catalog.
    // Keep Perspectica's explicitly supported choices visible; the Responses
    // endpoint still makes the authoritative per-account access decision.
    return this.writeModels([...PERSPECTICA_MODELS, ...models], epoch);
  }

  async getState(): Promise<AuthState> {
    const epoch = this.authEpoch;
    const models = await this.readModels();
    const pending = await this.readPending();
    if (!this.isCurrent(epoch)) {
      return {
        status: "unauthenticated",
        account: null,
        remembered: false,
        models: [],
        error: null,
      };
    }
    if (pending && pending.expiresAt > Date.now()) {
      return {
        status: "pending",
        account: null,
        remembered: pending.remember,
        models,
        error: null,
      };
    }

    try {
      let session = await this.readSession(epoch);
      if (!session && (await this.vault.has("chatgpt"))) {
        session = await this.restoreRemembered();
      }
      this.assertCurrent(epoch);
      if (!session) {
        return {
          status: "unauthenticated",
          account: null,
          remembered: false,
          models,
          error: null,
        };
      }
      return {
        status: "authenticated",
        account: session.account,
        remembered: session.remembered,
        models,
        error: null,
      };
    } catch (error) {
      if (!this.isCurrent(epoch)) {
        return {
          status: "unauthenticated",
          account: null,
          remembered: false,
          models: [],
          error: null,
        };
      }
      await this.sessionStorage.remove(SESSION_KEY);
      this.transientRefreshToken = null;
      return {
        status: "expired",
        account: null,
        remembered: true,
        models,
        error: error instanceof Error ? error.message : "Reconnect ChatGPT.",
      };
    }
  }

  async disconnect(): Promise<AuthState> {
    this.beginOperation();
    this.restoreInFlight = null;
    this.restoreInFlightEpoch = null;
    this.freshTokensInFlight = null;
    this.freshTokensInFlightEpoch = null;
    this.transientRefreshToken = null;
    await Promise.all([
      this.sessionStorage.remove(SESSION_KEY),
      this.sessionStorage.remove(PENDING_KEY),
      this.localStorage.remove(MODELS_KEY),
      // This removal is deliberately queued without an epoch assertion.
      // Calls started after disconnect enqueue their writes behind it, so the
      // removal clears every stale operation without deleting a newer login.
      this.queueVaultMutation(() => this.vault.remove("chatgpt")),
    ]);
    return {
      status: "unauthenticated",
      account: null,
      remembered: false,
      models: [],
      error: null,
    };
  }
}
