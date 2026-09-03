import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeChatRequestFallbacks: vi.fn(),
  requestChatDataMain: vi.fn(),
}));

vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: {
    state: new Proxy(
      {
        requestRetrys: 2,
        antiServerOverloads: true,
        banCharacterset: ["Hangul"],
      },
      {
        get(target, property, receiver) {
          if (property === "fallbackModels") {
            throw new Error("fallbackModels must be read from PresetStore");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ),
  },
}));

vi.mock("src/ts/stores/domain/presetStore.svelte", () => ({
  presetStore: {
    state: {
      fallbackModels: { model: ["fallback-model"] },
      fallbackWhenBlankResponse: true,
    },
  },
}));

vi.mock("@risuai/chat-core/requestLoop.cjs", () => ({
  executeChatRequestFallbacks: mocks.executeChatRequestFallbacks,
}));

vi.mock("../../parser/parser.svelte", () => ({
  risuEscape: (value: string) => value,
  risuUnescape: (value: string) => value,
}));
vi.mock("../../plugins/plugins.svelte", () => ({
  pluginV2: {
    replacerbeforeRequest: new Set(),
    replacerafterRequest: new Set(),
  },
}));
vi.mock("../../polyfill", () => ({
  safeStructuredClone: <T>(value: T): T => structuredClone(value),
}));
vi.mock("../../util", () => ({ sleep: vi.fn() }));
vi.mock("../../stores/domain/characterStore.svelte", () => ({
  characterStore: { currentCharacter: null },
}));
vi.mock("../mcp/mcp", () => ({ getTools: vi.fn() }));
vi.mock("../triggers", () => ({ runTrigger: vi.fn() }));
vi.mock("./request", () => ({
  requestChatDataMain: mocks.requestChatDataMain,
}));
vi.mock("../../chatTarget", () => ({ resolveChatTarget: vi.fn() }));

import { requestChatData } from "./chatRequestOrchestrator";

describe("requestChatData", () => {
  beforeEach(() => {
    mocks.executeChatRequestFallbacks.mockReset();
    mocks.executeChatRequestFallbacks.mockResolvedValue({
      type: "success",
      result: "ok",
    });
  });

  it("reads fallback models from the active preset", async () => {
    const response = await requestChatData(
      {
        currentChar: {},
        tools: [],
        formated: [{ role: "user", content: "hello" }],
      } as any,
      "model" as any,
    );

    expect(response).toEqual({ type: "success", result: "ok" });
    expect(mocks.executeChatRequestFallbacks).toHaveBeenCalledWith(
      {
        fallbackModels: ["fallback-model", ""],
        requestRetries: 2,
        antiServerOverloads: true,
        fallbackWhenBlankResponse: true,
        bannedCharacterSets: ["Hangul"],
      },
      expect.any(Object),
    );
  });

  it("preserves arg.staticModel when fallbackModel is empty", async () => {
    mocks.executeChatRequestFallbacks.mockImplementation(
      async (_options, callbacks) => {
        return callbacks.executeAttempt({ fallbackModel: "" });
      },
    );
    mocks.requestChatDataMain.mockResolvedValue({
      type: "success",
      result: "module-submodel-response",
    });

    const response = await requestChatData(
      {
        currentChar: {},
        tools: [],
        formated: [{ role: "user", content: "hello" }],
        staticModel: "gemini-flash-custom",
      } as any,
      "submodel" as any,
    );

    expect(response).toEqual({
      type: "success",
      result: "module-submodel-response",
    });
    expect(mocks.requestChatDataMain).toHaveBeenCalledWith(
      expect.objectContaining({
        staticModel: "gemini-flash-custom",
      }),
      "submodel",
      null,
    );
  });
});
