import { describe, expect, it, vi } from "vitest";

import { prepareBrowserProviderContext } from "./providerContextAdapter";

const mocks = vi.hoisted(() => ({
  db: {
    aiModel: "reverse_proxy",
    subModel: "reverse_proxy",
    seperateModelsForAxModels: false,
    seperateModels: {
      memory: "",
      emotion: "",
      otherAx: "",
      translate: "",
    },
    maxResponse: 512,
    temperature: 80,
    useStreaming: false,
    genTime: 1,
    extractJson: "",
    customProxyRequestModel: "proxy-main",
    customProxySubRequestModel: "proxy-aux",
    customAPIFormat: 0,
    forceReplaceUrl: "https://proxy.example/v1",
    proxyKey: "proxy-key",
    customModels: [],
    systemContentReplacement: "",
    systemRoleReplacement: "system",
  },
}));

vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: mocks.db },
}));
vi.mock("src/ts/stores/domain/presetStore.svelte", () => ({
  presetStore: { state: mocks.db },
}));

vi.mock("../../model/modellist", () => ({
  getModelInfo: (id: string) => ({ id, internalID: id, format: 0, flags: [] }),
}));

const request = {
  bias: {},
  formated: [{ role: "user", content: "hello" }],
} as any;

describe("prepareBrowserProviderContext provider role settings", () => {
  it("uses the Reverse Proxy main model for main requests", () => {
    const { prepared } = prepareBrowserProviderContext(request, "model");

    expect(prepared.modelInfo.internalID).toBe("proxy-main");
  });

  it.each(["submodel", "memory", "emotion", "otherAx", "translate"] as const)(
    "uses the Reverse Proxy auxiliary model for %s requests when no override is set",
    (mode) => {
      const { prepared } = prepareBrowserProviderContext(request, mode);

      expect(prepared.modelInfo.internalID).toBe("proxy-aux");
    },
  );

  it("uses the per-feature override for Reverse Proxy when separateModelsForAxModels is enabled", () => {
    mocks.db.seperateModelsForAxModels = true;
    (mocks.db as any).providerModelOverrides = {
      memory: { customProxyRequestModel: "proxy-memory-himoi" },
      translate: { customProxyRequestModel: "proxy-translate-gemma4" },
      emotion: {},
      otherAx: {},
    };

    const memory = prepareBrowserProviderContext(request, "memory");
    expect(memory.prepared.modelInfo.internalID).toBe("proxy-memory-himoi");

    const translate = prepareBrowserProviderContext(request, "translate");
    expect(translate.prepared.modelInfo.internalID).toBe("proxy-translate-gemma4");

    // Falls back to sub model when feature override is empty
    const emotion = prepareBrowserProviderContext(request, "emotion");
    expect(emotion.prepared.modelInfo.internalID).toBe("proxy-aux");

    // Main model is unaffected
    const main = prepareBrowserProviderContext(request, "model");
    expect(main.prepared.modelInfo.internalID).toBe("proxy-main");

    // Cleanup
    mocks.db.seperateModelsForAxModels = false;
  });
});
