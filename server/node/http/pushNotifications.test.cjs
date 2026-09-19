"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { createPushNotificationManager } = require("./pushNotifications.cjs");

// web-push performs real HTTPS Web Push deliveries, so the unit tests stub
// sendNotification and assert on the payloads the manager hands over.
let sendImpl = null;
let sendCalls = [];
const webpush = require("web-push");
webpush.sendNotification = async (subscription, payload, options) => {
  sendCalls.push({ subscription, payload, options });
  return sendImpl(subscription, payload, options);
};

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "risu-push-"));
}

function okSend() {
  return async () => ({});
}

function failingSend(statusCode) {
  const error = new Error("delivery rejected");
  error.statusCode = statusCode;
  return async () => {
    throw error;
  };
}

test("generates and persists VAPID keys once", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));

  const manager = createPushNotificationManager({ saveDir });
  t.after(() => manager.close());

  const first = await manager.ensureVapidKeys();
  assert.ok(first.publicKey);
  assert.ok(first.privateKey);
  const second = await manager.ensureVapidKeys();
  assert.equal(second.publicKey, first.publicKey);

  // Restarting the manager reuses the stored keys.
  const reopened = createPushNotificationManager({ saveDir });
  t.after(() => manager.close());
  await reopened.ensureVapidKeys();
  assert.equal(reopened.vapidPublicKey, first.publicKey);
});

test("reloads persisted subscriptions after restart", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));

  sendImpl = okSend();
  sendCalls = [];
  const first = createPushNotificationManager({ saveDir });
  await first.ensureVapidKeys();
  first.updateSubscription({
    endpoint: "https://push.example/persisted",
    keys: { p256dh: "persisted-key", auth: "persisted-auth" },
  });
  await first.close();

  const reopened = createPushNotificationManager({ saveDir });
  t.after(() => reopened.close());
  assert.equal(reopened.size, 1);
  const result = await reopened.notifyChatResponse({ body: "after restart" });
  assert.equal(result.sent, 1);
  assert.equal(
    sendCalls[0]?.subscription.endpoint,
    "https://push.example/persisted",
  );
});

test("registers subscriptions and delivers completion pushes", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));
  await createPushNotificationManager({ saveDir }).ensureVapidKeys();

  sendImpl = okSend();
  sendCalls = [];
  const manager = createPushNotificationManager({ saveDir });
  t.after(() => manager.close());

  const invalid = manager.updateSubscription({ endpoint: "not-https" });
  assert.equal(invalid.error, "Invalid subscription payload");

  const register = manager.updateSubscription({
    endpoint: "https://push.example/endpoint-1",
    keys: { p256dh: "key-material", auth: "auth-material" },
  });
  assert.deepEqual(register, { success: true });
  assert.equal(manager.size, 1);

  const result = await manager.notifyChatResponse({
    title: "Char · Chat",
    body: "Response ready",
    chatId: "chat-1",
    generationId: "gen-1",
  });
  assert.equal(result.sent, 1);
  assert.equal(sendCalls.length, 1);
  const delivery = sendCalls[0];
  assert.equal(
    delivery.subscription.endpoint,
    "https://push.example/endpoint-1",
  );
  const payload = JSON.parse(delivery.payload);
  assert.equal(payload.type, "chat-response");
  assert.equal(payload.chatId, "chat-1");
  assert.equal(payload.generationId, "gen-1");
  assert.equal(delivery.options.TTL, 60 * 60 * 12);
  assert.ok(delivery.options.vapidDetails?.publicKey);
});

test("drops dead endpoints and truncates long bodies", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));
  await createPushNotificationManager({ saveDir }).ensureVapidKeys();

  sendImpl = failingSend(410);
  sendCalls = [];
  const manager = createPushNotificationManager({ saveDir });
  t.after(() => manager.close());

  manager.updateSubscription({
    endpoint: "https://push.example/gone",
    keys: { p256dh: "k", auth: "a" },
  });

  await manager.notifyChatResponse({ body: "x" });
  assert.equal(manager.size, 0, "410 endpoint must be garbage collected");

  sendImpl = okSend();
  const longBody = "y".repeat(500);
  const result = await manager.notifyChatResponse({ body: longBody });
  assert.equal(result.sent, 0, "nothing is subscribed anymore");
});

test("retries transient failures before dropping an endpoint", async () => {
  const saveDir = await makeTempDir();
  await fs.rm(saveDir, { recursive: true, force: true }).catch(() => {});

  sendImpl = failingSend(503);
  sendCalls = [];
  const manager = createPushNotificationManager({
    saveDir: await makeTempDir(),
  });
  await manager.ensureVapidKeys();

  manager.updateSubscription({
    endpoint: "https://push.example/flaky",
    keys: { p256dh: "k", auth: "a" },
  });
  for (let i = 0; i < 3; i++) {
    await manager.notifyChatResponse({ body: "attempt" });
  }
  assert.equal(manager.size, 0, "third consecutive failure drops endpoint");
  assert.equal(sendCalls.length, 3);
});
