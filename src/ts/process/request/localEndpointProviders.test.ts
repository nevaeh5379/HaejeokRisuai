import { beforeEach, expect, test, vi } from "vitest";

const parser = vi.hoisted(() => vi.fn((text: string) => `parsed:${text}`));
const currentUiCharacter = vi.hoisted(() => ({ name: "Wrong UI" }));
const db = vi.hoisted(() => ({
  textgenWebUIStreamURL: "http://localhost:5000/api/v1/stream",
  textgenWebUIBlockingURL: "http://localhost:5000/api/v1/generate",
  localStopStrings: ["STOP {{char}}"],
  maxResponse: 256,
  ooba: {},
  top_p: 1,
  mancerHeader: "",
  reverseProxyOobaArgs: {},
  PresensePenalty: 0,
  frequencyPenalty: 0,
}));

vi.mock("../../../lang", () => ({
  language: { errors: { httpError: "HTTP" } },
}));
vi.mock("../../globalApi.svelte", () => ({ globalFetch: vi.fn() }));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: parser }));
vi.mock("../../stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: db },
}));
vi.mock("../../stores/domain/presetStore.svelte", () => ({
  presetStore: { state: db },
}));
vi.mock("../../stores/domain/characterStore.svelte", () => ({
  characterStore: { currentCharacter: currentUiCharacter },
}));
vi.mock("../prompt", () => ({ OobaParams: [] }));
vi.mock("../stringlize", () => ({
  getStopStrings: () => [],
  unstringlizeChat: vi.fn(),
}));
vi.mock("../templates/chatTemplate", () => ({
  applyChatTemplate: () => "prompt",
}));
vi.mock("./shared", () => ({
  applyAdditionalParameters: (body: any) => body,
  applyParameters: (body: any) => body,
  getAdditionalParameters: () => [],
}));

import { requestOoba, requestOobaLegacy } from "./localEndpointProviders";

beforeEach(() => parser.mockClear());

const targetCharacter = { type: "character", name: "Target" } as any;
const target = { characterId: "char-target", chatId: "chat-target" };
const requestArg = {
  formated: [],
  aiModel: "textgen_webui",
  maxTokens: 1024,
  temperature: 1,
  useStreaming: false,
  previewBody: true,
  currentChar: targetCharacter,
  triggerTarget: target,
  PresensePenalty: 0,
  frequencyPenalty: 0,
} as any;

test.each([
  ["legacy", requestOobaLegacy],
  ["openai compatible", requestOoba],
])(
  "parses %s stop strings with the generation target",
  async (_name, request) => {
    const result = await request(requestArg);
    expect(result.type).toBe("success");
    const payload = JSON.parse((result as any).result);
    const stops = payload.body.stopping_strings ?? payload.body.stop;
    expect(stops).toEqual(["parsed:STOP {{char}}"]);
    expect(parser).toHaveBeenCalledWith("STOP {{char}}", {
      chara: targetCharacter,
      chatTarget: target,
    });
  },
);
