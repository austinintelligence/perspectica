import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonStorageArea } from "../storage/areas";

const core = vi.hoisted(() => ({
  exchangeDeviceAuthorization: vi.fn(),
  listCodexModels: vi.fn(),
  parseUser: vi.fn(),
  pollDeviceCode: vi.fn(),
  refreshTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  resolveConfig: vi.fn(() => ({})),
}));

vi.mock("@opencoredev/loginwithchatgpt-core", () => core);

import { ChatGptSessionManager } from "./chatgpt-session";

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

function vault() {
  let chatgpt:
    | {
        refreshToken: string;
        accountId: string;
        email?: string;
        name?: string;
        plan?: string;
      }
    | undefined;
  return {
    has: vi.fn(async () => Boolean(chatgpt)),
    readChatGpt: vi.fn(async () => chatgpt),
    writeChatGpt: vi.fn(async (value) => {
      chatgpt = structuredClone(value);
    }),
    remove: vi.fn(async () => {
      chatgpt = undefined;
    }),
  };
}

describe("ChatGptSessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps Perspectica's supported models visible before the catalog catches up", async () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    session.values.set("perspectica.auth.session.v1", {
      accessToken: "access",
      refreshToken: "refresh",
      account: { accountId: "account-1" },
      expiresAt: Date.now() + 60 * 60_000,
      remembered: true,
    });
    core.listCodexModels.mockResolvedValue(["catalog-model"]);
    const manager = new ChatGptSessionManager(session, local, vault() as never);

    await expect(manager.discoverModels()).resolves.toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.4",
      "catalog-model",
    ]);
  });

  it("starts device authorization with remember-me attached to pending state", async () => {
    const session = new MemoryStorage();
    core.requestDeviceCode.mockResolvedValue({
      deviceAuthId: "device-auth",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
    });
    const manager = new ChatGptSessionManager(session, new MemoryStorage(), vault() as never);

    await expect(manager.begin(true)).resolves.toMatchObject({
      userCode: "ABCD-EFGH",
      intervalMs: 5_000,
    });
    expect(session.values.get("perspectica.auth.pending.v1")).toMatchObject({
      remember: true,
      deviceAuthId: "device-auth",
    });
  });

  it("rejects a device verification URL outside the pinned OpenAI host", async () => {
    const session = new MemoryStorage();
    core.requestDeviceCode.mockResolvedValue({
      deviceAuthId: "device-auth",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://example.test/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
    });
    const manager = new ChatGptSessionManager(session, new MemoryStorage(), vault() as never);

    await expect(manager.begin(true)).rejects.toThrow("untrusted device verification URL");
    expect(session.values.has("perspectica.auth.pending.v1")).toBe(false);
  });

  it("keeps a non-remembered refresh token out of session storage", async () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    const credentialVault = vault();
    core.pollDeviceCode.mockResolvedValue({
      status: "authorized",
      authorizationCode: "authorization-code",
      codeChallenge: "challenge",
      codeVerifier: "verifier",
    });
    core.exchangeDeviceAuthorization.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh-secret",
      accountId: "account-1",
      expiresAt: Date.now() + 60 * 60_000,
    });
    core.parseUser.mockReturnValue({ accountId: "account-1" });
    core.listCodexModels.mockResolvedValue([]);
    session.values.set("perspectica.auth.pending.v1", {
      deviceAuthId: "device-auth",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
      remember: false,
    });
    const manager = new ChatGptSessionManager(session, local, credentialVault as never);

    await expect(manager.poll()).resolves.toMatchObject({ status: "authenticated" });
    expect(JSON.stringify([...session.values.values()])).not.toContain("refresh-secret");
    expect(credentialVault.writeChatGpt).not.toHaveBeenCalled();
    expect(credentialVault.remove).toHaveBeenCalledWith("chatgpt");
  });

  it("sanitizes legacy plaintext refresh tokens already in session storage", async () => {
    const session = new MemoryStorage();
    session.values.set("perspectica.auth.session.v1", {
      accessToken: "access",
      refreshToken: "legacy-refresh-secret",
      account: { accountId: "account-1" },
      expiresAt: Date.now() + 60 * 60_000,
      remembered: false,
    });
    const manager = new ChatGptSessionManager(session, new MemoryStorage(), vault() as never);

    await expect(manager.getState()).resolves.toMatchObject({ status: "authenticated" });
    expect(JSON.stringify([...session.values.values()])).not.toContain("legacy-refresh-secret");
  });

  it("coalesces concurrent remembered-session restoration", async () => {
    const session = new MemoryStorage();
    const credentialVault = vault();
    await credentialVault.writeChatGpt({
      refreshToken: "remembered-refresh",
      accountId: "account-1",
    });
    core.refreshTokens.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "rotated-refresh",
      accountId: "account-1",
      expiresAt: Date.now() + 60 * 60_000,
    });
    const manager = new ChatGptSessionManager(
      session,
      new MemoryStorage(),
      credentialVault as never,
    );

    const [state, tokens] = await Promise.all([manager.getState(), manager.getFreshTokens()]);

    expect(state.status).toBe("authenticated");
    expect(tokens.accessToken).toBe("new-access");
    expect(core.refreshTokens).toHaveBeenCalledTimes(1);
    expect(credentialVault.writeChatGpt).toHaveBeenLastCalledWith({
      refreshToken: "rotated-refresh",
      accountId: "account-1",
    });
  });

  it("does not restore a login that finishes after disconnect", async () => {
    const session = new MemoryStorage();
    const credentialVault = vault();
    const exchange = deferred<{
      accessToken: string;
      refreshToken: string;
      accountId: string;
      expiresAt: number;
    }>();
    core.pollDeviceCode.mockResolvedValue({
      status: "authorized",
      authorizationCode: "authorization-code",
      codeChallenge: "challenge",
      codeVerifier: "verifier",
    });
    core.exchangeDeviceAuthorization.mockReturnValue(exchange.promise);
    core.parseUser.mockReturnValue({ accountId: "account-1" });
    session.values.set("perspectica.auth.pending.v1", {
      deviceAuthId: "device-auth",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
      remember: true,
    });
    const manager = new ChatGptSessionManager(
      session,
      new MemoryStorage(),
      credentialVault as never,
    );

    const polling = manager.poll();
    await vi.waitFor(() => expect(core.exchangeDeviceAuthorization).toHaveBeenCalled());
    await manager.disconnect();
    exchange.resolve({
      accessToken: "access",
      refreshToken: "refresh-secret",
      accountId: "account-1",
      expiresAt: Date.now() + 60 * 60_000,
    });

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(session.values.has("perspectica.auth.session.v1")).toBe(false);
    expect(credentialVault.writeChatGpt).not.toHaveBeenCalled();
  });

  it("waits for an in-flight login vault write before disconnect resolves", async () => {
    const session = new MemoryStorage();
    const credentialVault = vault();
    const vaultWrite = deferNextVaultWrite(credentialVault);
    core.pollDeviceCode.mockResolvedValue({
      status: "authorized",
      authorizationCode: "authorization-code",
      codeChallenge: "challenge",
      codeVerifier: "verifier",
    });
    core.exchangeDeviceAuthorization.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh-secret",
      accountId: "account-1",
      expiresAt: Date.now() + 60 * 60_000,
    });
    core.parseUser.mockReturnValue({ accountId: "account-1" });
    core.listCodexModels.mockResolvedValue([]);
    session.values.set("perspectica.auth.pending.v1", {
      deviceAuthId: "device-auth",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
      remember: true,
    });
    const manager = new ChatGptSessionManager(
      session,
      new MemoryStorage(),
      credentialVault as never,
    );

    const polling = manager.poll();
    const pollingResult = expect(polling).rejects.toMatchObject({ name: "AbortError" });
    await vaultWrite.entered.promise;

    let disconnected = false;
    const disconnecting = manager.disconnect().then((state) => {
      disconnected = true;
      return state;
    });
    await Promise.resolve();
    expect(disconnected).toBe(false);

    vaultWrite.release.resolve(undefined);
    await expect(disconnecting).resolves.toMatchObject({ status: "unauthenticated" });
    await pollingResult;
    expect(await credentialVault.readChatGpt()).toBeUndefined();
    expect(session.values.has("perspectica.auth.session.v1")).toBe(false);
  });

  it("does not let the disconnect barrier delete a newer login", async () => {
    const session = new MemoryStorage();
    const credentialVault = vault();
    const staleVaultWrite = deferNextVaultWrite(credentialVault);
    core.pollDeviceCode.mockResolvedValue({
      status: "authorized",
      authorizationCode: "authorization-code",
      codeChallenge: "challenge",
      codeVerifier: "verifier",
    });
    core.exchangeDeviceAuthorization
      .mockResolvedValueOnce({
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
        accountId: "stale-account",
        expiresAt: Date.now() + 60 * 60_000,
      })
      .mockResolvedValueOnce({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        accountId: "new-account",
        expiresAt: Date.now() + 60 * 60_000,
      });
    core.parseUser
      .mockReturnValueOnce({ accountId: "stale-account" })
      .mockReturnValueOnce({ accountId: "new-account" });
    core.listCodexModels.mockResolvedValue([]);
    core.requestDeviceCode.mockResolvedValue({
      deviceAuthId: "new-device-auth",
      userCode: "NEW-CODE",
      verificationUrl: "https://auth.openai.com/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
    });
    session.values.set("perspectica.auth.pending.v1", {
      deviceAuthId: "stale-device-auth",
      userCode: "OLD-CODE",
      verificationUrl: "https://auth.openai.com/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
      remember: true,
    });
    const manager = new ChatGptSessionManager(
      session,
      new MemoryStorage(),
      credentialVault as never,
    );

    const stalePolling = manager.poll();
    const staleResult = expect(stalePolling).rejects.toMatchObject({ name: "AbortError" });
    await staleVaultWrite.entered.promise;

    const disconnecting = manager.disconnect();
    await manager.begin(true);
    const newPolling = manager.poll();
    staleVaultWrite.release.resolve(undefined);

    await staleResult;
    await expect(disconnecting).resolves.toMatchObject({ status: "unauthenticated" });
    await expect(newPolling).resolves.toMatchObject({
      status: "authenticated",
      state: { account: { accountId: "new-account" } },
    });
    expect(await credentialVault.readChatGpt()).toMatchObject({
      refreshToken: "new-refresh",
      accountId: "new-account",
    });
  });

  it("does not write pending login state after disconnect", async () => {
    const session = new MemoryStorage();
    const device = deferred<{
      deviceAuthId: string;
      userCode: string;
      verificationUrl: string;
      interval: number;
      expiresAt: number;
    }>();
    core.requestDeviceCode.mockReturnValue(device.promise);
    const manager = new ChatGptSessionManager(session, new MemoryStorage(), vault() as never);

    const beginning = manager.begin(true);
    await vi.waitFor(() => expect(core.requestDeviceCode).toHaveBeenCalled());
    await manager.disconnect();
    device.resolve({
      deviceAuthId: "device-auth",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
      interval: 5,
      expiresAt: Date.now() + 300_000,
    });

    await expect(beginning).rejects.toMatchObject({ name: "AbortError" });
    expect(session.values.has("perspectica.auth.pending.v1")).toBe(false);
  });

  it("does not persist refreshed tokens after disconnect", async () => {
    const session = new MemoryStorage();
    const credentialVault = vault();
    await credentialVault.writeChatGpt({
      refreshToken: "remembered-refresh",
      accountId: "account-1",
    });
    session.values.set("perspectica.auth.session.v1", {
      accessToken: "old-access",
      account: { accountId: "account-1" },
      expiresAt: Date.now() - 1,
      remembered: true,
    });
    const refresh = deferred<{
      accessToken: string;
      refreshToken: string;
      accountId: string;
      expiresAt: number;
    }>();
    core.refreshTokens.mockReturnValue(refresh.promise);
    const manager = new ChatGptSessionManager(
      session,
      new MemoryStorage(),
      credentialVault as never,
    );

    const refreshing = manager.getFreshTokens();
    await vi.waitFor(() => expect(core.refreshTokens).toHaveBeenCalled());
    await manager.disconnect();
    refresh.resolve({
      accessToken: "new-access",
      refreshToken: "rotated-refresh",
      accountId: "account-1",
      expiresAt: Date.now() + 60 * 60_000,
    });

    await expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    expect(session.values.has("perspectica.auth.session.v1")).toBe(false);
    expect(credentialVault.writeChatGpt).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight refresh vault write before disconnect resolves", async () => {
    const session = new MemoryStorage();
    const credentialVault = vault();
    await credentialVault.writeChatGpt({
      refreshToken: "remembered-refresh",
      accountId: "account-1",
    });
    const vaultWrite = deferNextVaultWrite(credentialVault);
    session.values.set("perspectica.auth.session.v1", {
      accessToken: "old-access",
      account: { accountId: "account-1" },
      expiresAt: Date.now() - 1,
      remembered: true,
    });
    core.refreshTokens.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "rotated-refresh",
      accountId: "account-1",
      expiresAt: Date.now() + 60 * 60_000,
    });
    const manager = new ChatGptSessionManager(
      session,
      new MemoryStorage(),
      credentialVault as never,
    );

    const refreshing = manager.getFreshTokens();
    const refreshResult = expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    await vaultWrite.entered.promise;

    let disconnected = false;
    const disconnecting = manager.disconnect().then((state) => {
      disconnected = true;
      return state;
    });
    await Promise.resolve();
    expect(disconnected).toBe(false);

    vaultWrite.release.resolve(undefined);
    await expect(disconnecting).resolves.toMatchObject({ status: "unauthenticated" });
    await refreshResult;
    expect(await credentialVault.readChatGpt()).toBeUndefined();
    expect(session.values.has("perspectica.auth.session.v1")).toBe(false);
  });

  it("disconnects both temporary and remembered credentials", async () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    const credentialVault = vault();
    session.values.set("perspectica.auth.session.v1", { secret: true });
    session.values.set("perspectica.auth.pending.v1", { pending: true });
    local.values.set("perspectica.auth.models.v1", ["gpt-5.6-luna"]);
    const manager = new ChatGptSessionManager(session, local, credentialVault as never);

    await expect(manager.disconnect()).resolves.toMatchObject({
      status: "unauthenticated",
      remembered: false,
    });
    expect(session.values.size).toBe(0);
    expect(local.values.size).toBe(0);
    expect(credentialVault.remove).toHaveBeenCalledWith("chatgpt");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferNextVaultWrite(credentialVault: ReturnType<typeof vault>) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const write = credentialVault.writeChatGpt.getMockImplementation();
  if (!write) throw new Error("The test vault has no write implementation.");
  credentialVault.writeChatGpt.mockImplementationOnce(async (value) => {
    entered.resolve(undefined);
    await release.promise;
    await write(value);
  });
  return { entered, release };
}
