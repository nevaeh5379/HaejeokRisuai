import { describe, expect, it, vi } from "vitest";
import { runHypaV3Experimental, type HypaV3Runtime } from "./engine.js";
import { runHypaV3Legacy } from "./legacyEngine.js";
import { createHypaV3Preset } from "./preset.js";

function createRuntime(
  summarize: HypaV3Runtime["summarize"] = async () => "summary",
): HypaV3Runtime {
  return {
    createRateLimiter: () => ({
      queuedTaskCount: 0,
      taskQueueChangeCallback: null,
      async executeBatch<T>(tasks: Array<() => Promise<T>>) {
        return {
          results: await Promise.all(
            tasks.map(async (task) => ({
              success: true,
              data: await task(),
            })),
          ),
        };
      },
    }),
    createEmbeddingProcessor: () => {
      throw new Error("Embedding should not be used by this test");
    },
    createLegacyEmbeddingProcessor: () => {
      throw new Error("Legacy embedding should not be used by this test");
    },
    summarize,
    onProgress: () => undefined,
    random: () => 0.5,
  };
}

describe("Hypa V3 experimental engine", () => {
  it("returns unsummarized history without invoking platform services", async () => {
    const summarize = vi.fn(async () => "unused");
    const chats = [
      { role: "user" as const, content: "hello", memo: "a" },
      { role: "assistant" as const, content: "hi", memo: "b" },
    ];

    const result = await runHypaV3Experimental(
      {
        chats,
        currentTokens: 20,
        maxContextTokens: 100,
        maxResponseTokens: 5,
        characterId: "character",
        conversationId: "chat",
        settings: createHypaV3Preset().settings,
        tokenizer: {
          tokenizeChat: async () => 0,
          tokenizeChatsDetailed: async (messages) => messages.map(() => 5),
        },
      },
      createRuntime(summarize),
    );

    expect(result.error).toBeUndefined();
    expect(result.chats).toEqual(chats);
    expect(result.currentTokens).toBe(15);
    expect(result.memory).toEqual({ summaries: [] });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("summarizes through injected services and returns serializable state", async () => {
    const summarize = vi.fn(async () => "portable summary");
    const chats = [
      { role: "user" as const, content: "one", memo: "a" },
      { role: "assistant" as const, content: "two", memo: "b" },
      { role: "user" as const, content: "three", memo: "c" },
      { role: "assistant" as const, content: "four", memo: "d" },
      { role: "user" as const, content: "five", memo: "e" },
    ];
    const settings = createHypaV3Preset("test", {
      recentMemoryRatio: 1,
      similarMemoryRatio: 0,
      memoryTokensRatio: 0.5,
      maxChatsPerSummary: 2,
      queryChatCount: 3,
    }).settings;

    const result = await runHypaV3Experimental(
      {
        chats,
        currentTokens: 80,
        maxContextTokens: 50,
        maxResponseTokens: 0,
        characterId: "character",
        conversationId: "chat",
        settings,
        tokenizer: {
          tokenizeChat: async () => 0,
          tokenizeChatsDetailed: async (messages) =>
            messages.map((message) =>
              message.content === "portable summary\n\n" ? 1 : 30,
            ),
        },
      },
      createRuntime(summarize),
    );

    expect(result.error).toBeUndefined();
    expect(summarize).toHaveBeenCalledOnce();
    expect(result.memory?.summaries).toEqual([
      {
        text: "portable summary",
        chatMemos: ["a", "b"],
        isImportant: false,
        categoryId: undefined,
        tags: [],
      },
    ]);
    expect(result.chats.at(0)?.role).toBe("system");
  });
});

describe("Hypa V3 legacy engine", () => {
  it("also runs without RisuAI globals", async () => {
    const chats = [
      { role: "user" as const, content: "hello", memo: "a" },
      { role: "assistant" as const, content: "hi", memo: "b" },
    ];

    const result = await runHypaV3Legacy(
      {
        chats,
        currentTokens: 20,
        maxContextTokens: 100,
        maxResponseTokens: 5,
        characterId: "character",
        conversationId: "chat",
        settings: createHypaV3Preset().settings,
        tokenizer: {
          tokenizeChat: async () => 0,
          tokenizeChatsDetailed: async (messages) => messages.map(() => 5),
        },
      },
      createRuntime(),
    );

    expect(result.error).toBeUndefined();
    expect(result.chats).toEqual([
      {
        role: "system",
        content: "<Past Events Summary>\n\n</Past Events Summary>",
        memo: "supaMemory",
      },
      ...chats,
    ]);
    expect(result.currentTokens).toBe(15);
    expect(result.memory).toEqual({ summaries: [] });
  });
});
