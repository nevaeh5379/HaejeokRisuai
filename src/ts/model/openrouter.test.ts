import { describe, expect, it } from "vitest";
import { toModelGridItem, type OpenRouterModelInfo } from "./openrouter";

describe("openrouter", () => {
  it("formats model grid item with proper price formatting", () => {
    const model: OpenRouterModelInfo = {
      id: "meta-llama/llama-3-8b-instruct",
      name: "meta-llama/llama-3-8b-instruct - Free",
      cleanName: "llama-3-8b-instruct",
      provider: "meta-llama",
      price: 0,
      priceDisplay: "Free",
      context_length: 8192,
      description: "Fast model",
      promptPrice1M: 0,
      completionPrice1M: 0,
      cacheReadPrice1M: undefined,
      cacheWritePrice1M: undefined,
      internalReasoningPrice1M: undefined,
    };

    const item = toModelGridItem(model);
    expect(item.id).toBe("meta-llama/llama-3-8b-instruct");
    expect(item.displayName).toBe("llama-3-8b-instruct");
    expect(item.providerName).toBe("meta-llama");
    expect(item.sortPrice).toBe(0);
    expect(item.prices).toEqual([
      { label: "In", value: "Free" },
      { label: "Out", value: "Free" },
    ]);
  });
});
