import { expect, test, vi } from "vitest";

const appendMessage = vi.hoisted(() => vi.fn(async () => {}));
const reportFailure = vi.hoisted(() => vi.fn());
const alertError = vi.hoisted(() => vi.fn());
const chatA = vi.hoisted(() => ({ id: "chat-a", message: [] as any[] }));
const chatB = vi.hoisted(() => ({ id: "chat-b", message: [] as any[] }));

vi.mock("../../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { inlayErrorResponse: true } },
}));
vi.mock("../../stores/domain/characterStore.svelte", () => ({
  characterStore: {
    characters: [
      { chaId: "char-a", chatPage: 0, chats: [chatA] },
      { chaId: "char-b", chatPage: 0, chats: [chatB] },
    ],
  },
}));
vi.mock("../../stores.svelte", () => ({
  selectedCharID: {
    subscribe(run: (value: number) => void) {
      run(1);
      return () => {};
    },
  },
}));
vi.mock("../../alert", () => ({ alertError }));
vi.mock("../../stores/domain/messageStore.svelte", () => ({
  messageStore: { appendMessage },
}));
vi.mock("../nodeGenerationLifecycle", () => ({
  reportNodeGenerationFailure: reportFailure,
}));

import {
  createChatErrorHandler,
  isCancellationError,
} from "./error.svelte";

test("keeps early generation errors pinned to the target chat", () => {
  const throwError = createChatErrorHandler({
    selectedChar: -1,
    selectedChat: -1,
    targetChatId: "chat-a",
  });

  throwError("early failure");

  expect(reportFailure).toHaveBeenCalledWith("chat-a", "early failure");
  expect(appendMessage).toHaveBeenCalledWith(
    "chat-a",
    expect.objectContaining({ role: "char" }),
  );
  expect(chatA.message).toHaveLength(1);
  expect(chatB.message).toHaveLength(0);
  expect(alertError).not.toHaveBeenCalled();
});

test("treats a remote abort as a cancellation, not a failure", () => {
  reportFailure.mockClear();
  appendMessage.mockClear();
  alertError.mockClear();
  chatA.message.length = 0;

  const controller = new AbortController();
  controller.abort();
  const handler = createChatErrorHandler(
    { selectedChar: -1, selectedChat: -1, targetChatId: "chat-a" },
    controller.signal,
  );

  handler("This operation was aborted");

  expect(reportFailure).not.toHaveBeenCalled();
  expect(appendMessage).not.toHaveBeenCalled();
  expect(alertError).not.toHaveBeenCalled();

  const abortError = new Error("This operation was aborted");
  abortError.name = "AbortError";
  expect(isCancellationError(abortError)).toBe(true);
  expect(isCancellationError(new Error("real failure"))).toBe(false);
  expect(isCancellationError("string failure")).toBe(false);
});