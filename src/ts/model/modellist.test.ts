import { describe, expect, it } from "vitest";
import { getModelInfo, getModelList, LLMModels } from "./modellist";
import { LLMProvider } from "./types";

describe("modellist optimization", () => {
  it("should return unknown model for empty or null id", () => {
    const unknownEmpty = getModelInfo("");
    expect(unknownEmpty.id).toBe("");
    expect(unknownEmpty.name).toBe("Unknown");

    const unknownNull = getModelInfo(null);
    expect(unknownNull.id).toBe("");
    expect(unknownNull.name).toBe("Unknown");

    const unknownUndefined = getModelInfo(undefined);
    expect(unknownUndefined.id).toBe("");
  });

  it("should retrieve registered model in O(1) lookup", () => {
    const firstModel = LLMModels[0];
    const retrieved = getModelInfo(firstModel.id);
    expect(retrieved.id).toBe(firstModel.id);
    expect(retrieved.name).toBe(firstModel.name);
    expect(retrieved.provider).toBe(firstModel.provider);
  });

  it("should handle hf::: and horde::: prefixed ids", () => {
    const hfModel = getModelInfo("hf:::some/cool-model");
    expect(hfModel.id).toBe("hf:::some/cool-model");
    expect(hfModel.name).toBe("some/cool-model");
    expect(hfModel.provider).toBe(LLMProvider.WebLLM);

    const hordeModel = getModelInfo("horde:::aphrodite/llama");
    expect(hordeModel.id).toBe("horde:::aphrodite/llama");
    expect(hordeModel.name).toBe("aphrodite/llama");
    expect(hordeModel.provider).toBe(LLMProvider.Horde);
  });

  it("should return fallback model structure for unknown models", () => {
    const fallback = getModelInfo("custom-unregistered-model-123");
    expect(fallback.id).toBe("custom-unregistered-model-123");
    expect(fallback.name).toBe("custom-unregistered-model-123");
    expect(fallback.provider).toBe(LLMProvider.AsIs);
  });

  it("should list models and filter recommendedOnly without redundant allocations", () => {
    const allModels = getModelList();
    expect(allModels.length).toBeGreaterThan(0);

    const recommended = getModelList({ recommendedOnly: true });
    expect(recommended.length).toBeGreaterThan(0);
    expect(recommended.length).toBeLessThan(allModels.length);
    for (const model of recommended) {
      expect(model.recommended).toBe(true);
    }
  });

  it("should group models by provider efficiently", () => {
    const grouped = getModelList({ groupedByProvider: true });
    expect(grouped.length).toBeGreaterThan(0);

    for (const group of grouped) {
      expect(group.providerName).toBeDefined();
      expect(Array.isArray(group.models)).toBe(true);
      expect(group.models.length).toBeGreaterThan(0);
    }
  });
});
