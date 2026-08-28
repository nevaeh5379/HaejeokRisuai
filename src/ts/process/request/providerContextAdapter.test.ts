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
    "uses the Reverse Proxy auxiliary model for %s requests",
    (mode) => {
      const { prepared } = prepareBrowserProviderContext(request, mode);

      expect(prepared.modelInfo.internalID).toBe("proxy-aux");
    },
  );
});
