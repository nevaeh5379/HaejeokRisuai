import { expect, it, vi } from "vitest";

vi.mock("src/ts/stores/domain/presetStore.svelte", () => ({
  presetStore: { state: { aiModel: "reverse_proxy" } },
}));
vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { customTokenizer: "", useTokenizerCaching: false } },
}));
vi.mock("src/ts/stores/domain/characterStore.svelte", () => ({
  characterStore: {},
}));
vi.mock("./process/files/inlays", () => ({ supportsInlayImage: () => false }));
vi.mock("./parser/parser.svelte", () => ({
  risuChatParser: (text: string) => text,
}));
vi.mock("./process/models/local", () => ({ tokenizeGGUFModel: vi.fn() }));
vi.mock("./globalApi.svelte", () => ({
  forageStorage: {},
  globalFetch: vi.fn(),
}));
vi.mock("./model/modellist", () => ({
  getModelInfo: () => ({ tokenizer: 0 }),
  LLMTokenizer: {},
}));
vi.mock("./plugins/plugins.svelte", () => ({
  pluginV2: { providerOptions: new Map() },
}));
vi.mock("./platform", () => ({ isNodeServer: false }));
vi.mock("./storage/files/nodeStorage", () => ({ NodeStorage: class {} }));
vi.mock("@dqbd/tiktoken/encoders/cl100k_base.json", () => ({
  bpe_ranks: "cl",
  special_tokens: {},
  pat_str: "",
}));
vi.mock("src/etc/o200k_base.json", () => ({
  bpe_ranks: "o",
  special_tokens: {},
  pat_str: "",
}));
vi.mock("@dqbd/tiktoken", () => ({
  Tiktoken: class {
    freed = false;
    constructor(private model: string) {}
    free() {
      this.freed = true;
    }
    encode() {
      if (this.freed) throw new Error("null pointer passed to rust");
      return new Uint32Array([this.model === "cl" ? 1 : 2]);
    }
  },
}));

it("can prepare reverse-proxy illustration tokens while other UI token counts switch encodings", async () => {
  const { encode, encodeWithTokenizer } = await import("./tokenizer");
  await encodeWithTokenizer("initial UI text", "tik");
  const illustration = encode("illustration prompt", "reverse_proxy");
  const ui = encodeWithTokenizer("character text", "tik");
  const counts = await Promise.all([illustration, ui]);
  expect(Array.from(counts[0])).toEqual([2]);
  expect(Array.from(counts[1])).toEqual([1]);
});
