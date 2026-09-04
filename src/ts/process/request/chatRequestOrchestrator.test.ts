import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeChatRequestFallbacks: vi.fn(),
  requestChatDataMain: vi.fn(),
  getModules: vi.fn(() => []),
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
vi.mock("../modules", () => ({ getModules: mocks.getModules }));
vi.mock("../triggers", () => ({ runTrigger: vi.fn() }));
vi.mock("./request", () => ({
  requestChatDataMain: mocks.requestChatDataMain,
}));
vi.mock("../../chatTarget", () => ({ resolveChatTarget: vi.fn() }));

import { requestChatData } from "./chatRequestOrchestrator";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";

describe("requestChatData", () => {
  beforeEach(() => {
    mocks.requestChatDataMain
      .mockReset()
      .mockResolvedValue({ type: "success", result: "ok" });
    settingsStore.state.enableModuleSubModel = false;
    mocks.getModules.mockReset().mockReturnValue([]);
    mocks.executeChatRequestFallbacks.mockReset();
    mocks.executeChatRequestFallbacks.mockResolvedValue({
      type: "success",
      result: "ok",
    });
  });

  it.each(["submodel", "otherAx"] as const)(
    "routes %s using request-local source and preserves explicit fallbacks",
    async (mode) => {
      settingsStore.state.enableModuleSubModel = true;
      mocks.getModules.mockReturnValue([
        {
          id: "owner",
          name: "Owner",
          subModel: "owner-model",
          subModelRequestRules: [
            {
              enabled: true,
              phrases: ["unique instruction"],
              sourceModuleId: "backend",
            },
          ],
        },
      ] as any);
      mocks.executeChatRequestFallbacks.mockImplementation(
        async (_options, callbacks) => {
          await callbacks.executeAttempt({ fallbackModel: "" });
          return callbacks.executeAttempt({ fallbackModel: "retry-model" });
        },
      );
      const arg = {
        currentChar: {},
        tools: [],
        formated: [{ role: "user", content: "unique instruction" }],
        sourceModuleId: "backend",
        staticModel: "backend-model",
      } as any;
      await requestChatData(arg, mode);
      expect(mocks.requestChatDataMain).toHaveBeenNthCalledWith(
        mocks.requestChatDataMain.mock.calls.length - 1,
        expect.objectContaining({ staticModel: "owner-model" }),
        mode,
        null,
      );
      expect(mocks.requestChatDataMain).toHaveBeenLastCalledWith(
        expect.objectContaining({ staticModel: "retry-model" }),
        mode,
        null,
      );
      expect(arg.staticModel).toBe("backend-model");
      await requestChatData({ ...arg, sourceModuleId: "other" }, mode);
      expect(mocks.requestChatDataMain.mock.calls.at(-2)?.[0].staticModel).toBe(
        "backend-model",
      );
      await requestChatData(arg, "model");
      expect(mocks.requestChatDataMain.mock.calls.at(-2)?.[0].staticModel).toBe(
        "backend-model",
      );
      settingsStore.state.enableModuleSubModel = false;
      await requestChatData(arg, mode);
      expect(mocks.requestChatDataMain.mock.calls.at(-2)?.[0].staticModel).toBe(
        "backend-model",
      );
    },
  );

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
