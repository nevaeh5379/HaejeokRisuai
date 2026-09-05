"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");

const SUBSCRIPTIONS_FILE = "push-subscriptions.json";
// A subscription whose push endpoint keeps failing (expired/unsubscribed)
// gets dropped after this many consecutive failures.
const MAX_ENDPOINT_FAILURES = 3;
const TTL = 60 * 60 * 12; // 12h: a finished generation is not news after that

function normalizeTitle(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "RisuAI";
}

function normalizeBody(value, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return fallback || "Response ready";
  return trimmed.length > 320 ? `${trimmed.slice(0, 319)}…` : trimmed;
}

function generateVapidKeys() {
  return webpush.generateVAPIDKeys();
}

/**
 * Server-side Web Push delivery for chat generation completions.
 *
 * The page cannot fire notifications while the browser has suspended it, so
 * the server sends the "response ready" push itself; the service worker
 * receives it and shows the OS notification.
 */
function createPushNotificationManager({ saveDir, logger = console } = {}) {
  const filePath = path.join(
    saveDir || process.cwd(),
    "push-subscriptions.json",
  );
  const vapidPrivateKeyPath = path.join(
    saveDir || process.cwd(),
    "__vapid_private_key.pem",
  );
  const vapidPublicKeyPath = path.join(
    saveDir || process.cwd(),
    "__vapid_public_key.txt",
  );

  /** @type {Map<string, {endpoint: string, keys: {p256dh: string, auth: string}, failures: number, chatIds: Set<string>}>} */
  const subscriptions = new Map();
  let vapidKeys = null;

  function loadVapidKeys() {
    if (vapidKeys) return vapidKeys;
    try {
      vapidKeys = {
        publicKey: fs.readFileSync(vapidPublicKeyPath, "utf8").trim(),
        privateKey: fs.readFileSync(vapidPrivateKeyPath, "utf8").trim(),
      };
      return vapidKeys;
    } catch {
      return null;
    }
  }

  async function ensureVapidKeys() {
    if (loadVapidKeys()) return vapidKeys;
    vapidKeys = webpush.generateVAPIDKeys();
    await Promise.all([
      fsp.writeFile(vapidPrivateKeyPath, vapidKeys.privateKey + "\n", {
        mode: 0o600,
      }),
      fsp.writeFile(vapidPublicKeyPath, vapidKeys.publicKey + "\n"),
    ]);
    logger.info?.("[push] generated new VAPID keys");
    return vapidKeys;
  }

  async function persist() {
    const snapshot = JSON.stringify(
      [...subscriptions.values()].map((sub) => ({
        endpoint: sub.endpoint,
        keys: sub.keys,
        chatIds: [...sub.chatIds],
      })),
      null,
      2,
    );
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
    await fsp.rename(tmp, filePath);
  }

  function loadPersistedSubscriptions() {
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger.warn?.("[push] failed to load subscriptions", error);
      }
      return;
    }
    if (!Array.isArray(snapshot)) {
      logger.warn?.("[push] ignored invalid subscription snapshot");
      return;
    }
    for (const persisted of snapshot) {
      const result = updateSubscription(persisted);
      if (result.error) continue;
      const subscription = subscriptions.get(persisted.endpoint);
      if (subscription && Array.isArray(persisted.chatIds)) {
        subscription.chatIds = new Set(
          persisted.chatIds.filter((chatId) => typeof chatId === "string"),
        );
      }
    }
  }

  function updateSubscription(subscription) {
    const endpoint = subscription?.endpoint;
    const keys = subscription?.keys;
    if (
      typeof endpoint !== "string" ||
      !endpoint.startsWith("https://") ||
      !keys ||
      typeof keys.p256dh !== "string" ||
      typeof keys.auth !== "string"
    ) {
      return { error: "Invalid subscription payload" };
    }
    const existing = subscriptions.get(endpoint);
    if (existing) {
      existing.keys = keys;
      existing.failures = 0;
      return { success: true };
    }
    subscriptions.set(endpoint, {
      endpoint,
      keys,
      failures: 0,
      chatIds: new Set(),
    });
    return { success: true };
  }

  function removeSubscription(subscription) {
    const endpoint = subscription?.endpoint;
    if (typeof endpoint !== "string") {
      return { error: "Invalid subscription payload" };
    }
    subscriptions.delete(endpoint);
    return { success: true };
  }

  loadPersistedSubscriptions();

  async function sendNotification(subscription, payload) {
    const keys = loadVapidKeys();
    if (!keys) return false;
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: "mailto:risuai@noreply.local",
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
          },
          TTL,
        },
      );
      subscription.failures = 0;
      return true;
    } catch (error) {
      const statusCode = error?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        subscriptions.delete(subscription.endpoint);
      } else {
        subscription.failures += 1;
        if (subscription.failures >= MAX_ENDPOINT_FAILURES) {
          subscriptions.delete(subscription.endpoint);
        }
      }
      logger.warn?.("[push] send failed", statusCode ?? error);
      return false;
    }
  }

  /**
   * Notifies every subscription about a finished generation. chatId lets the
   * client-side service worker skip duplicates the page already showed.
   */
  async function notifyChatResponse({
    title,
    body,
    chatId,
    characterId,
    generationId,
  }) {
    if (subscriptions.size === 0) return { sent: 0 };
    const keys = loadVapidKeys();
    if (!keys) return { sent: 0 };
    const payload = {
      type: "chat-response",
      title: normalizeTitle(title),
      body: normalizeBody(body),
      chatId: typeof chatId === "string" ? chatId : null,
      characterId: typeof characterId === "string" ? characterId : null,
      generationId: typeof generationId === "string" ? generationId : null,
      sentAt: Date.now(),
    };
    let sent = 0;
    for (const subscription of [...subscriptions.values()]) {
      const delivered = await sendNotification(subscription, payload);
      if (delivered) sent += 1;
    }
    if ([...subscriptions.values()].some((sub) => sub.failures > 0)) {
      void persist().catch(() => {});
    }
    return { sent };
  }

  async function close() {
    await persist().catch(() => {});
  }

  return {
    updateSubscription,
    removeSubscription,
    notifyChatResponse,
    ensureVapidKeys,
    get vapidPublicKey() {
      return loadVapidKeys()?.publicKey ?? null;
    },
    get size() {
      return subscriptions.size;
    },
    close,
  };
}

module.exports = {
  createPushNotificationManager,
  generateVapidKeys,
};
