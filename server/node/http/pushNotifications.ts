"use strict";

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import webpush from "web-push";

const SUBSCRIPTIONS_FILE: any = "push-subscriptions.json";
// A subscription whose push endpoint keeps failing (expired/unsubscribed)
// gets dropped after this many consecutive failures.
const MAX_ENDPOINT_FAILURES: any = 3;
const TTL: any = 60 * 60 * 12; // 12h: a finished generation is not news after that

function normalizeTitle(value?: any): any {
  const trimmed: any = typeof value === "string" ? value.trim() : "";
  return trimmed || "RisuAI";
}

function normalizeBody(value?: any, fallback?: any): any {
  const trimmed: any = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return fallback || "Response ready";
  return trimmed.length > 320 ? `${trimmed.slice(0, 319)}…` : trimmed;
}

function generateVapidKeys(): any {
  return webpush.generateVAPIDKeys();
}

/**
 * Server-side Web Push delivery for chat generation completions.
 *
 * The page cannot fire notifications while the browser has suspended it, so
 * the server sends the "response ready" push itself; the service worker
 * receives it and shows the OS notification.
 */
function createPushNotificationManager({
  saveDir,
  logger = console,
}: any = {}): any {
  const filePath: any = path.join(
    saveDir || process.cwd(),
    "push-subscriptions.json",
  );
  const vapidPrivateKeyPath: any = path.join(
    saveDir || process.cwd(),
    "__vapid_private_key.pem",
  );
  const vapidPublicKeyPath: any = path.join(
    saveDir || process.cwd(),
    "__vapid_public_key.txt",
  );

  /** @type {Map<string, {endpoint: string, keys: {p256dh: string, auth: string}, failures: number, chatIds: Set<string>}>} */
  const subscriptions: any = new Map();
  let vapidKeys: any = null;

  function loadVapidKeys(): any {
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

  async function ensureVapidKeys(): Promise<any> {
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

  async function persist(): Promise<any> {
    const snapshot: any = JSON.stringify(
      [...subscriptions.values()].map((sub?: any) => ({
        endpoint: sub.endpoint,
        keys: sub.keys,
        chatIds: [...sub.chatIds],
      })),
      null,
      2,
    );
    const tmp: any = `${filePath}.tmp`;
    await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
    await fsp.rename(tmp, filePath);
  }

  function loadPersistedSubscriptions(): any {
    let snapshot: any;
    try {
      snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error: any) {
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
      const result: any = updateSubscription(persisted);
      if (result.error) continue;
      const subscription: any = subscriptions.get(persisted.endpoint);
      if (subscription && Array.isArray(persisted.chatIds)) {
        subscription.chatIds = new Set(
          persisted.chatIds.filter(
            (chatId?: any) => typeof chatId === "string",
          ),
        );
      }
    }
  }

  function updateSubscription(subscription?: any): any {
    const endpoint: any = subscription?.endpoint;
    const keys: any = subscription?.keys;
    if (
      typeof endpoint !== "string" ||
      !endpoint.startsWith("https://") ||
      !keys ||
      typeof keys.p256dh !== "string" ||
      typeof keys.auth !== "string"
    ) {
      return { error: "Invalid subscription payload" };
    }
    const existing: any = subscriptions.get(endpoint);
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

  function removeSubscription(subscription?: any): any {
    const endpoint: any = subscription?.endpoint;
    if (typeof endpoint !== "string") {
      return { error: "Invalid subscription payload" };
    }
    subscriptions.delete(endpoint);
    return { success: true };
  }

  loadPersistedSubscriptions();

  async function sendNotification(
    subscription?: any,
    payload?: any,
  ): Promise<any> {
    const keys: any = loadVapidKeys();
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
    } catch (error: any) {
      const statusCode: any = error?.statusCode;
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
  }: any): Promise<any> {
    if (subscriptions.size === 0) return { sent: 0 };
    const keys: any = loadVapidKeys();
    if (!keys) return { sent: 0 };
    const payload: any = {
      type: "chat-response",
      title: normalizeTitle(title),
      body: normalizeBody(body),
      chatId: typeof chatId === "string" ? chatId : null,
      characterId: typeof characterId === "string" ? characterId : null,
      generationId: typeof generationId === "string" ? generationId : null,
      sentAt: Date.now(),
    };
    let sent: any = 0;
    for (const subscription of [...subscriptions.values()]) {
      const delivered: any = await sendNotification(subscription, payload);
      if (delivered) sent += 1;
    }
    if ([...subscriptions.values()].some((sub?: any) => sub.failures > 0)) {
      void persist().catch(() => {});
    }
    return { sent };
  }

  async function close(): Promise<any> {
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

export { createPushNotificationManager, generateVapidKeys };
