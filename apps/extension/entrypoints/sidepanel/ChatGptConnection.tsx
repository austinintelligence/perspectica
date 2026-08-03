import { useCallback, useEffect, useState } from "react";
import type { AuthState, DeviceAuthorization } from "../../src/runtime/messages";
import { subscribeRuntimePush } from "../../src/runtime/client";
import {
  beginChatGptLogin,
  disconnectChatGpt,
  getPendingChatGptLogin,
  getRuntimeState,
  pollChatGptLogin,
  requestChatGptHostAccess,
} from "./api";
import { BrandHeader } from "./BrandHeader";
import { OpenAiBlossomIcon, RefreshIcon, ShieldLockIcon, TargetIcon } from "./Icons";

const EMPTY_AUTH: AuthState = {
  status: "loading",
  account: null,
  remembered: false,
  models: [],
  error: null,
};

export interface PerspecticaChatGptConnection {
  status: AuthState["status"];
  isAuthenticated: boolean;
  isPending: boolean;
  isConnecting: boolean;
  userCode: string | null;
  verificationUrl: string | null;
  error: string | null;
  copied: boolean;
  models: string[];
  login: (remember: boolean) => Promise<void>;
  reopen: () => void;
  copyCode: () => Promise<void>;
  logout: () => Promise<void>;
}

export function usePerspecticaChatGpt(): PerspecticaChatGptConnection {
  const [auth, setAuth] = useState<AuthState>(EMPTY_AUTH);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void getRuntimeState()
      .then(async (runtime) => {
        if (!active) return;
        setAuth(runtime.auth);
        if (runtime.auth.status === "pending") {
          setDevice(await getPendingChatGptLogin());
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setAuth({ ...EMPTY_AUTH, status: "error" });
        setError(cause instanceof Error ? cause.message : "Could not read the saved connection.");
      });
    const unsubscribe = subscribeRuntimePush((message) => {
      if (message.type === "auth.changed") setAuth(message.auth);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!device || auth.status !== "pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await pollChatGptLogin();
        if (cancelled) return;
        if (result.status === "authenticated") {
          setAuth(result.state);
          setDevice(null);
          setConnecting(false);
          setError(null);
          return;
        }
        timer = setTimeout(poll, Math.max(1_500, device.intervalMs));
      } catch (cause) {
        if (cancelled) return;
        if (Date.now() >= device.expiresAt) {
          setAuth((current) => ({
            ...current,
            status: "expired",
            error: "The one-time sign-in code expired. Start a new Login with ChatGPT flow.",
          }));
          setDevice(null);
          setConnecting(false);
          return;
        }
        // Polling errors are transient (the browser may briefly lose access
        // to OpenAI). Keep the device authorization alive and schedule the
        // next poll instead of leaving the UI permanently pending.
        setError(cause instanceof Error ? cause.message : "ChatGPT sign-in is still pending.");
        timer = setTimeout(poll, Math.max(1_500, device.intervalMs));
      }
    };
    timer = setTimeout(poll, Math.max(500, device.intervalMs));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [auth.status, device]);

  const login = useCallback(async (remember: boolean) => {
    setConnecting(true);
    setError(null);
    try {
      // This request must remain in the direct Login-button gesture. It grants
      // only the two OpenAI origins needed by device authorization and model
      // calls; article access is requested separately later in onboarding.
      await requestChatGptHostAccess();
      const authorization = await beginChatGptLogin(remember);
      setDevice(authorization);
      setAuth((current) => ({ ...current, status: "pending", remembered: remember }));
      await chrome.tabs.create({ url: authorization.verificationUrl });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ChatGPT sign-in could not start.");
      setConnecting(false);
    }
  }, []);

  const reopen = useCallback(() => {
    if (device?.verificationUrl) {
      void chrome.tabs.create({ url: device.verificationUrl });
    }
  }, [device]);

  const copyCode = useCallback(async () => {
    if (!device?.userCode) return;
    await navigator.clipboard.writeText(device.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }, [device]);

  const logout = useCallback(async () => {
    const state = await disconnectChatGpt();
    setAuth(state);
    setDevice(null);
    setError(null);
  }, []);

  return {
    status: auth.status,
    isAuthenticated: auth.status === "authenticated",
    isPending: auth.status === "pending" && Boolean(device),
    isConnecting: connecting,
    userCode: device?.userCode ?? null,
    verificationUrl: device?.verificationUrl ?? null,
    error: error ?? auth.error,
    copied,
    models: auth.models,
    login,
    reopen,
    copyCode,
    logout,
  };
}

interface ChatGptConnectionScreenProps {
  connection: PerspecticaChatGptConnection;
  onOpenSettings: () => void;
}

export function ChatGptConnectionScreen({
  connection,
  onOpenSettings,
}: ChatGptConnectionScreenProps) {
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [remember, setRemember] = useState(true);

  return (
    <div className="connection-shell atmosphere-page">
      <BrandHeader action="menu" actionLabel="Open preferences" onAction={onOpenSettings} />

      <main className="connection-main">
        <p className="eyebrow">Analysis provider</p>
        <h1>Connect ChatGPT</h1>
        <p className="connection-lede">Use your ChatGPT plan to analyze the articles you read.</p>

        <div className="connection-assurances">
          <div>
            <TargetIcon />
            <span>Runs entirely inside Perspectica</span>
          </div>
          <div>
            <ShieldLockIcon />
            <span>Your saved connection is encrypted on this device</span>
          </div>
          <div>
            <RefreshIcon />
            <span>Disconnect and erase it whenever you want</span>
          </div>
        </div>

        {connection.status === "loading" ? (
          <p className="connection-state">Checking your saved connection…</p>
        ) : null}

        {connection.isPending ? (
          <div className="device-flow" aria-live="polite">
            <p className="connection-state">Finish signing in with OpenAI.</p>
            <span className="device-label">Your one-time code</span>
            <strong className="device-code">{connection.userCode}</strong>
            <div className="connection-actions">
              <button type="button" className="chatgpt-action" onClick={connection.reopen}>
                <OpenAiBlossomIcon />
                Continue sign-in
              </button>
              <button
                type="button"
                className="text-action"
                onClick={() => void connection.copyCode()}
              >
                {connection.copied ? "Copied" : "Copy code"}
              </button>
            </div>
          </div>
        ) : null}

        {connection.status !== "loading" && !connection.isPending ? (
          <>
            <label className="remember-device">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>
                <strong>Remember me on this device</strong>
                <small>Reconnect automatically after browser and computer restarts.</small>
              </span>
            </label>
            <button
              type="button"
              className="chatgpt-action connect-button"
              onClick={() => void connection.login(remember)}
              disabled={connection.isConnecting}
            >
              <OpenAiBlossomIcon />
              {connection.isConnecting ? "Starting secure sign-in…" : "Login with ChatGPT"}
            </button>
          </>
        ) : null}

        {connection.error ? (
          <p className="connection-error" role="alert">
            {connection.error}
          </p>
        ) : null}

        <button
          type="button"
          className="connection-help"
          aria-expanded={showConnectionDetails}
          onClick={() => setShowConnectionDetails((current) => !current)}
        >
          How your connection is used
        </button>
        {showConnectionDetails ? (
          <p className="connection-note">
            Perspectica sends the article and its analysis prompts directly to ChatGPT. When
            remembered, your refresh token is encrypted locally and your access token remains
            temporary. Perspectica operates no account or article server.
          </p>
        ) : null}
        <button
          type="button"
          className="connection-help team-toggle"
          aria-expanded={showTeam}
          onClick={() => setShowTeam((current) => !current)}
        >
          About us
        </button>
        {showTeam ? (
          <section className="team-credits" aria-label="Perspectica team">
            <p className="team-credits-title">Built by</p>
            <ul>
              <li>
                <strong>Austin Morgan</strong>
                <span>Developer &amp; AI orchestration</span>
              </li>
              <li>
                <strong>Lathik Ram C.</strong>
                <span>Concept lead, UI design &amp; outreach</span>
              </li>
              <li>
                <strong>Mathew Estis</strong>
                <span>Developer &amp; project coordination</span>
              </li>
              <li>
                <strong>Jordan Allen</strong>
                <span>Brand design &amp; QA testing</span>
              </li>
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
