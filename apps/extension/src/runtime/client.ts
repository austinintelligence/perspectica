import {
  ExtensionResponseSchema,
  RuntimePushSchema,
  RUNTIME_PORT_NAME,
  createRequestId,
  type ExtensionRequestInput,
  type RuntimePush,
} from "./messages";

export async function sendRuntimeRequest<T>(request: ExtensionRequestInput): Promise<T> {
  const requestId = createRequestId();
  const response = ExtensionResponseSchema.parse(
    await chrome.runtime.sendMessage({ ...request, requestId }),
  );
  if (!response.ok) throw new Error(response.error);
  return response.data as T;
}

export function subscribeRuntimePush(listener: (message: RuntimePush) => void): () => void {
  return subscribeRuntimePushWithStatus(listener);
}

export function subscribeRuntimePushWithStatus(
  listener: (message: RuntimePush) => void,
  onStatus?: (status: "connected" | "reconnecting") => void,
): () => void {
  const onMessage = (message: unknown) => {
    const parsed = RuntimePushSchema.safeParse(message);
    if (parsed.success) listener(parsed.data);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  // Ports keep the side panel subscribed while the MV3 service worker is
  // recreated. Broadcast messages remain as a compatibility fallback for
  // older unpacked builds and for auth updates.
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 250;
  const connect = () => {
    if (closed) return;
    try {
      port = chrome.runtime.connect({ name: RUNTIME_PORT_NAME });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => {
        port?.onMessage.removeListener(onMessage);
        port = null;
        if (closed) return;
        onStatus?.("reconnecting");
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(4_000, backoffMs * 2);
      });
      backoffMs = 250;
      onStatus?.("connected");
    } catch {
      onStatus?.("reconnecting");
      reconnectTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(4_000, backoffMs * 2);
    }
  };
  connect();
  const unsubscribe = () => {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    chrome.runtime.onMessage.removeListener(onMessage);
    port?.onMessage.removeListener(onMessage);
    try {
      port?.disconnect();
    } catch {
      // A disconnected port is already cleanly unsubscribed.
    }
  };
  return unsubscribe;
}
