import { getNodeServerProxyAuth } from "../storage/files/nodeStorage";
import { getNodeClientSessionId } from "../network/nodeClientSession";
import { isCapacitor, isNodeServer } from "../platform";

const SUBSCRIBED_ENDPOINT_KEY = "risuPushSubscribedEndpoint";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function pushAuthHeaders(): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "risu-auth": await getNodeServerProxyAuth(),
    "x-risu-client-id": getNodeClientSessionId(),
  };
}

function supportsWebPush(): boolean {
  return (
    isNodeServer &&
    !isCapacitor &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined"
  );
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function unsubscribeStale(endpoint: string): Promise<void> {
  try {
    await fetch("/api/push/subscriptions", {
      method: "DELETE",
      headers: await pushAuthHeaders(),
      body: JSON.stringify({ endpoint }),
    });
  } catch {}
}

/**
 * Registers a Web Push subscription for chat-response notifications. The
 * permission prompt must run inside a user gesture, so this is called from
 * the send path. Safe to call repeatedly: an existing valid subscription is
 * re-uploaded (keys can rotate) instead of re-prompting.
 */
export async function subscribeChatResponsePush(): Promise<boolean> {
  if (!supportsWebPush() || Notification.permission !== "granted") return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await currentSubscription();
    if (!subscription) {
      const keyResponse = await fetch("/api/push/vapid-public-key", {
        headers: await pushAuthHeaders(),
      });
      if (!keyResponse.ok) return false;
      const { publicKey } = await keyResponse.json();
      if (typeof publicKey !== "string" || !publicKey) return false;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const json = subscription.toJSON();
    const endpoint = subscription.endpoint;
    try {
      localStorage.setItem(SUBSCRIBED_ENDPOINT_KEY, endpoint);
    } catch {}
    const response = await fetch("/api/push/subscriptions", {
      method: "POST",
      headers: await pushAuthHeaders(),
      body: JSON.stringify(json),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Removes the server-side subscription record and the browser subscription
 * itself. Best effort: the server also garbage-collects dead endpoints.
 */
export async function unsubscribeChatResponsePush(): Promise<void> {
  if (!supportsWebPush()) return;
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    await unsubscribeStale(subscription.endpoint);
    await subscription.unsubscribe();
    try {
      localStorage.removeItem(SUBSCRIBED_ENDPOINT_KEY);
    } catch {}
  } catch {}
}

/**
 * Re-syncs the subscription with the server after a boot. Covers server-side
 * data loss (the subscription file is on disk) and endpoint rotation.
 */
export async function syncChatResponsePush(): Promise<void> {
  if (!supportsWebPush() || Notification.permission !== "granted") return;
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    const json = subscription.toJSON();
    await fetch("/api/push/subscriptions", {
      method: "POST",
      headers: await pushAuthHeaders(),
      body: JSON.stringify(json),
    });
  } catch {}
}
