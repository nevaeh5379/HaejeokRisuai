import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parser: vi.fn((text: string, arg?: any) =>
    text.replaceAll("{{char}}", arg?.chara?.name ?? "fallback"),
  ),
  request: vi.fn(),
  start: vi.fn(),
  continueSession: vi.fn(),
  cancel: vi.fn(),
  storage: null as any,
}));

vi.mock("../../platform", () => ({ isNodeServer: true }));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: mocks.parser }));
vi.mock("../../globalApi.svelte", () => ({
  forageStorage: {
    get realStorage() {
      return mocks.storage;
    },
  },
}));
vi.mock("../../storage/nodeStorage", () => {
  class NodeStorage {
    startHypaMemorySession(...args: any[]) {
      return mocks.start(...args);
    }
    continueHypaMemorySession(...args: any[]) {
      return mocks.continueSession(...args);
    }
    cancelHypaMemorySession(...args: any[]) {
      return mocks.cancel(...args);
    }
  }
  return { NodeStorage };
});
vi.mock("../../tokenizer", () => ({ tokenize: vi.fn() }));
vi.mock("../request/chatRequestOrchestrator", () => ({
  requestChatData: mocks.request,
}));
vi.mock("../transformers", () => ({ runSummarizer: vi.fn() }));
vi.mock("../webllm", () => ({ chatCompletion: vi.fn() }));

import { NodeStorage } from "../../storage/nodeStorage";
import { tryRunNodeHypaMemory } from "./nodeHypaMemory";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storage = new NodeStorage();
  mocks.request.mockResolvedValue({ type: "success", result: "summary" });
  mocks.start.mockResolvedValue({
    status: "action",
    sessionId: "session",
    action: {
      id: "action",
      type: "summarize",
      messages: [{ role: "system", content: "{{char}}" }],
      parseContents: true,
      model: "subModel",
    },
  });
  mocks.continueSession.mockResolvedValue({ status: "done", result: "complete" });
});

test("keeps generation context through browser-side Node Hypa actions", async () => {
  const context = {
    currentChar: { name: "Target", chaId: "char-1" } as any,
    chatTarget: { characterId: "char-1", chatId: "chat-1" },
  };

  const result = await tryRunNodeHypaMemory(
    { mode: "v3" },
    { tokenizeChatsDetailed: vi.fn() } as any,
    context,
  );

  expect(result).toEqual({ handled: true, result: "complete" });
  expect(mocks.parser).toHaveBeenCalledWith("{{char}}", {
    chara: context.currentChar,
    chatTarget: context.chatTarget,
  });
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      currentChar: context.currentChar,
      triggerTarget: context.chatTarget,
      formated: [expect.objectContaining({ content: "Target" })],
    }),
    "memory",
  );
  expect(mocks.continueSession).toHaveBeenCalledWith("session", "action", {
    ok: true,
    text: "summary",
  });
});
