import { expect, test, vi } from "vitest";

const parser = vi.hoisted(() => vi.fn((text: string) => text));
const requestChatData = vi.hoisted(() =>
  vi.fn(async () => ({ type: "success", result: "summary" } as const)),
);
const storage = vi.hoisted(() => ({
  startHypaMemorySession: vi.fn(async () => ({
    status: "action" as const,
    sessionId: "session-1",
    action: {
      id: "action-1",
      type: "summarize" as const,
      messages: [{ role: "user", content: "{{char}}", memo: "m1" }],
      parseContents: true,
      model: "subModel",
    },
  })),
  continueHypaMemorySession: vi.fn(async () => ({
    status: "done" as const,
    result: { ok: true },
  })),
  cancelHypaMemorySession: vi.fn(async () => {}),
}));

vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: parser }));
vi.mock("../../globalApi.svelte", () => ({
  forageStorage: { realStorage: storage },
}));
vi.mock("../../platform", () => ({ isNodeServer: true }));
vi.mock("../../storage/nodeStorage", () => ({
  NodeStorage: class {
    static [Symbol.hasInstance](instance: unknown) {
      return instance === storage;
    }
  },
}));
vi.mock("../../tokenizer", () => ({ tokenize: vi.fn(async () => 1) }));
vi.mock("../request/chatRequestOrchestrator", () => ({ requestChatData }));
vi.mock("../transformers", () => ({ runSummarizer: vi.fn() }));
vi.mock("../webllm", () => ({ chatCompletion: vi.fn() }));

import { tryRunNodeHypaMemory } from "./nodeHypaMemory";

const tokenizer = {
  tokenizeChatsDetailed: vi.fn(async () => [1]),
} as never;

const currentChar = { name: "Target", chaId: "char-a" } as never;
const chatTarget = { characterIndex: 3, chatIndex: 4 };
test("keeps generation context through Node Hypa browser actions", async () => {
  const result = await tryRunNodeHypaMemory(
    { mode: "v3" },
    tokenizer,
    { currentChar, chatTarget },
  );

  expect(result).toEqual({ handled: true, result: { ok: true } });
  expect(parser).toHaveBeenCalledWith("{{char}}", {
    chara: currentChar,
    chatTarget,
  });
  expect(requestChatData).toHaveBeenCalledWith(
    expect.objectContaining({
      currentChar,
      triggerTarget: chatTarget,
      formated: [expect.objectContaining({ content: "{{char}}" })],
    }),
    "memory",
  );
  expect(storage.continueHypaMemorySession).toHaveBeenCalledWith(
    "session-1",
    "action-1",
    { ok: true, text: "summary" },
  );
});
