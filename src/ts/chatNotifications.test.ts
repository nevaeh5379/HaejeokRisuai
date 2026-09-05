import { beforeEach, expect, test, vi } from "vitest";

const requestNativePermission = vi.hoisted(() => vi.fn(async () => true));
const nativeState = vi.hoisted(() => ({ native: false }));

vi.mock("./androidChatLifecycle", () => ({
  completeNativeChatRequest: vi.fn(async () => {}),
  showNativeChatNotification: vi.fn(async () => {}),
  usesNativeChatLifecycle: () => nativeState.native,
  requestNativeChatNotificationPermission: requestNativePermission,
}));
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
let notificationCtor: ReturnType<typeof vi.fn>;
const swController = vi.hoisted(() => ({
  post: null as
    ((msg: { type?: string }, transfer?: Transferable[]) => void) | null,
}));

beforeEach(() => {
  requestNativePermission.mockClear();
  nativeState.native = false;
  requestPermission = vi.fn(async () => "granted");
  notificationCtor = vi.fn();
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: Object.assign(notificationCtor, {
      permission: "default",
      requestPermission,
    }),
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

test("skips notification when the service worker already notified", async () => {
  // Emulate the SW handshake: when the page posts QUERY_CHAT_RESPONSE_SHOWN,
  // the worker answers shown=true over the transferred MessageChannel.
  (globalThis.Notification as any).permission = "granted";

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
    expect(notificationCtor).not.toHaveBeenCalled();
  } finally {
    (globalThis as any).MessageChannel = originalMessageChannel;
    swController.post = null;
    (globalThis as any).__lastFakeChannel = null;
  }
});

test("shows notification when the service worker has not notified", async () => {
  (globalThis.Notification as any).permission = "granted";

  // No SW controller in this test run: the query resolves false immediately.
  const { notifyChatResponse } = await importModule();
  await notifyChatResponse({
    chatId: "chat-1",
    dedupeKey: "model-job:gen-fresh",
  });
  expect(notificationCtor).toHaveBeenCalledTimes(1);
});

test("plays audio when playMessage is true and notification is disabled", async () => {
  const playMock = vi.fn().mockResolvedValue(undefined);
  class FakeAudio {
    play = playMock;
  }
  const originalAudio = globalThis.Audio;
  (globalThis as any).Audio = FakeAudio;

  const { settingsStore } = await import("./stores/domain/settingsStore.svelte");
  (settingsStore.state as any).playMessage = true;
  (settingsStore.state as any).notification = false;

  try {
    const { notifyChatResponse } = await importModule();
    await notifyChatResponse({
      chatId: "chat-1",
      dedupeKey: "local:sound-test-only",
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).not.toHaveBeenCalled();
  } finally {
    (globalThis as any).Audio = originalAudio;
    (settingsStore.state as any).playMessage = false;
    (settingsStore.state as any).notification = true;
  }
});

test("suppresses audio when service worker already notified", async () => {
  const playMock = vi.fn().mockResolvedValue(undefined);
  class FakeAudio {
    play = playMock;
  }
  const originalAudio = globalThis.Audio;
  (globalThis as any).Audio = FakeAudio;

  const { settingsStore } = await import("./stores/domain/settingsStore.svelte");
  (settingsStore.state as any).playMessage = true;

  class FakePort {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    postMessage(): void {}
    close(): void {}
  }
  const originalMessageChannel = globalThis.MessageChannel;
  (globalThis as any).MessageChannel = class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      (globalThis as any).__lastFakeChannel = this;
    }
  };

  swController.post = (msg: { type?: string }) => {
    if (msg?.type === "QUERY_CHAT_RESPONSE_SHOWN") {
      const channel = (globalThis as any).__lastFakeChannel;
      channel?.port1.onmessage?.({ data: { shown: true } });
    }
  };

  try {
    const { notifyChatResponse } = await importModule();
    await notifyChatResponse({
      chatId: "chat-1",
      dedupeKey: "model-job:gen-sound-suppressed",
    });
    expect(playMock).not.toHaveBeenCalled();
  } finally {
    (globalThis as any).Audio = originalAudio;
    (globalThis as any).MessageChannel = originalMessageChannel;
    swController.post = null;
    (globalThis as any).__lastFakeChannel = null;
    (settingsStore.state as any).playMessage = false;
  }
});
