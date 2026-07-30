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
  const onMessage = (message: unknown) => {
    const parsed = RuntimePushSchema.safeParse(message);
    if (parsed.success) listener(parsed.data);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  // Ports keep the side panel subscribed while the MV3 service worker is
  // recreated. Broadcast messages remain as a compatibility fallback for
  // older unpacked builds and for auth updates.
  let port: chrome.runtime.Port | null = null;
  try {
    port = chrome.runtime.connect({ name: RUNTIME_PORT_NAME });
    port.onMessage.addListener(onMessage);
  } catch {
    // Snapshot polling remains available when Chrome is briefly recreating
    // the MV3 service worker and cannot establish a long-lived port.
  }
  const unsubscribe = () => {
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
