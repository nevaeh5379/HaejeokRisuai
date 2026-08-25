import { describe, expect, it } from "vitest";
import {
  prepareProviderExecutionContext,
  resolveRequestModel,
} from "@risuai/chat-core/providerContext.cjs";

const settings = {
  primaryModel: "gpt-main",
  subModel: "gpt-sub",
  separateModelsForAxModels: true,
  separateModels: { memory: "memory-model" },
  maxResponseTokens: 512,
  temperaturePercent: 80,
  useStreaming: true,
  genTime: 2,
  extractJson: "default",
  reverseProxy: {
    requestModel: "proxy-model",
    format: 18,
    url: "https://proxy.example",
    key: "proxy-key",
  },
  customModels: [{ id: "xcustom:::one", url: "https://custom", key: "custom-key" }],
};

const modelInfo = (id: string) => ({ id, internalID: id, format: 0 });

describe("provider execution context", () => {
  it("resolves primary, sub, static, and separate models", () => {
    expect(resolveRequestModel({ mode: "model" }, settings)).toBe("gpt-main");
    expect(resolveRequestModel({ mode: "submodel" }, settings)).toBe("gpt-sub");
    expect(resolveRequestModel({ mode: "memory" }, settings)).toBe("memory-model");
    expect(resolveRequestModel({ mode: "memory", staticModel: "fixed" }, settings)).toBe("fixed");
  });
  it("derives shared generation options", () => {
    const prepared = prepareProviderExecutionContext(
      { mode: "model", useStreaming: true },
      settings,
      modelInfo,
    );
    expect(prepared).toMatchObject({
      aiModel: "gpt-main",
      maxTokens: 512,
      temperature: 0.8,
      useStreaming: true,
      continue: false,
      multiGen: true,
      extractJson: "default",
      pluginBlocked: false,
    });
  });

  it("applies reverse proxy model and connection overrides", () => {
    const prepared = prepareProviderExecutionContext(
      { mode: "model", staticModel: "reverse_proxy" },
      settings,
      modelInfo,
    );
    expect(prepared.modelInfo).toMatchObject({ internalID: "proxy-model", format: 18 });
    expect(prepared.customURL).toBe("https://proxy.example");
    expect(prepared.key).toBe("proxy-key");
  });

  it("resolves custom model connection settings", () => {
    const prepared = prepareProviderExecutionContext(
      { mode: "model", staticModel: "xcustom:::one" },
      settings,
      modelInfo,
    );
    expect(prepared.customURL).toBe("https://custom");
    expect(prepared.key).toBe("custom-key");
  });
});
