import { beforeEach, expect, test, vi } from "vitest";

const requestNativePermission = vi.hoisted(() => vi.fn(async () => true));
const nativeState = vi.hoisted(() => ({ native: false }));

vi.mock("./androidChatLifecycle", () => ({
  completeNativeChatRequest: vi.fn(async () => {}),
  showNativeChatNotification: vi.fn(async () => {}),
  usesNativeChatLifecycle: () => nativeState.native,
  requestNativeChatNotificationPermission: requestNativePermission,
}));
vi.mock("./alert", () => ({ alertToast: vi.fn() }));
vi.mock("./chatTabs.svelte", () => ({
  chatTabsStore: { markUnread: vi.fn() },
  findChatTarget: vi.fn(() => null),
  openChatTargetInTab: vi.fn(),
}));
vi.mock("./stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [] },
}));
vi.mock("./stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { notification: true } },
}));
vi.mock("./network/pushSubscriptions", () => ({
  subscribeChatResponsePush: vi.fn(async () => true),
  unsubscribeChatResponsePush: vi.fn(async () => {}),
  syncChatResponsePush: vi.fn(async () => {}),
}));

let requestPermission: ReturnType<typeof vi.fn>;
const swController = vi.hoisted(() => ({
  post: null as
    ((msg: { type?: string }, transfer?: Transferable[]) => void) | null,
}));

beforeEach(() => {
  requestNativePermission.mockClear();
  nativeState.native = false;
  requestPermission = vi.fn(async () => "granted");
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "default", requestPermission },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      get serviceWorker() {
        return {
          controller: swController.post
            ? {
                postMessage: (msg: unknown, transfer?: Transferable[]) =>
                  swController.post?.(msg as { type?: string }, transfer),
              }
            : null,
        };
      },
    },
  });
  swController.post = null;
});

async function importModule() {
  const module = await import("./chatNotifications");
  module.resetChatNotificationPermissionForTests();
  return module;
}

test("requests web notification permission once per session", async () => {
  const { ensureChatNotificationPermission: ensure } = await importModule();

  await ensure();
  expect(requestPermission).toHaveBeenCalledTimes(1);

  await ensure();
  expect(requestPermission).toHaveBeenCalledTimes(1);
});

test("skips the prompt when permission is already decided", async () => {
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "granted", requestPermission },
  });
  const { ensureChatNotificationPermission: ensureGranted } =
    await importModule();
  await ensureGranted();
  expect(requestPermission).not.toHaveBeenCalled();

  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "denied", requestPermission },
  });
  const { ensureChatNotificationPermission: ensureDenied } =
    await importModule();
  await ensureDenied();
  expect(requestPermission).not.toHaveBeenCalled();
});

test("does nothing when the notification setting is off", async () => {
  const { settingsStore } =
    await import("./stores/domain/settingsStore.svelte");
  (settingsStore.state as { notification: boolean }).notification = false;
  const { ensureChatNotificationPermission: ensure } = await importModule();
  await ensure();
  expect(requestPermission).not.toHaveBeenCalled();
  (settingsStore.state as { notification: boolean }).notification = true;
});

test("native lifecycle delegates to the Capacitor permission request", async () => {
  nativeState.native = true;
  const { ensureChatNotificationPermission: ensure } = await importModule();

  await ensure();
  expect(requestNativePermission).toHaveBeenCalledTimes(1);
  expect(requestPermission).not.toHaveBeenCalled();
});

test("skips in-page alarm when the service worker already notified", async () => {
  // Emulate the SW handshake: when the page posts QUERY_CHAT_RESPONSE_SHOWN,
  // the worker answers shown=true over the transferred MessageChannel.
  const { alertToast } = await import("./alert");
  const alertToastMock = alertToast as ReturnType<typeof vi.fn>;
  alertToastMock.mockClear();

  class FakePort {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    postMessage(): void {}
    start(): void {}
  }
  const originalMessageChannel = globalThis.MessageChannel;
  class FakeChannel {
    port1 = new FakePort();
    port2 = new FakePort();
  }
  (globalThis as any).MessageChannel = FakeChannel;

  swController.post = (msg: { type?: string }) => {
    if (msg?.type === "QUERY_CHAT_RESPONSE_SHOWN") {
      // The page listens on port1 of the channel it just created; deliver
      // the SW reply there as the worker would over the real channel.
      setTimeout(() => {
        void 0;
      }, 0);
      // The exact port reference is captured by the page via closure; the
      // FakeChannel created inside swAlreadyNotifiedChatResponse is the
      // most recent one, so answer through its port1.
      const channel = (globalThis as any).__lastFakeChannel as
        FakeChannel | undefined;
      channel?.port1.onmessage?.({ data: { shown: true } });
    }
  };
  (globalThis as any).__lastFakeChannel = null;
  const originalChannelCtor = FakeChannel;
  // Track the channel created by the page for the reply path.
  (globalThis as any).MessageChannel = class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      (globalThis as any).__lastFakeChannel = this;
    }
  };
  void originalChannelCtor;

  try {
    const { notifyChatResponse } = await importModule();
    await notifyChatResponse({
      chatId: "chat-1",
      dedupeKey: "model-job:gen-dup",
    });
    // The SW push already told the user; the page must stay silent.
    expect(alertToastMock).not.toHaveBeenCalled();
  } finally {
    (globalThis as any).MessageChannel = originalMessageChannel;
    swController.post = null;
    (globalThis as any).__lastFakeChannel = null;
  }
});

test("shows the in-page alarm when the service worker has not notified", async () => {
  const { alertToast } = await import("./alert");
  const alertToastMock = alertToast as ReturnType<typeof vi.fn>;
  alertToastMock.mockClear();

  // No SW controller in this test run: the query resolves false immediately.
  const { notifyChatResponse } = await importModule();
  await notifyChatResponse({
    chatId: "chat-1",
    dedupeKey: "model-job:gen-fresh",
  });
  expect(alertToastMock).toHaveBeenCalledTimes(1);
});
