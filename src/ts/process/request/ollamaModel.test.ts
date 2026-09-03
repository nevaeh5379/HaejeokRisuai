import { describe, expect, it } from "vitest";

import { resolveOllamaRequestModel } from "./ollamaModel";

const settings = {
  ollamaModel: "local-main",
  ollamaSubModel: "local-aux",
  ollamaCloudModel: "cloud-main",
  ollamaCloudSubModel: "cloud-aux",
};

describe("resolveOllamaRequestModel", () => {
  it("keeps local and cloud main models independent", () => {
    expect(resolveOllamaRequestModel(settings, "local", "model")).toBe(
      "local-main",
    );
    expect(resolveOllamaRequestModel(settings, "cloud", "model")).toBe(
      "cloud-main",
    );
  });

  it.each(["submodel", "memory", "emotion", "otherAx", "translate"] as const)(
    "uses the auxiliary model for %s requests",
    (mode) => {
      expect(resolveOllamaRequestModel(settings, "local", mode)).toBe(
        "local-aux",
      );
      expect(resolveOllamaRequestModel(settings, "cloud", mode)).toBe(
        "cloud-aux",
      );
    },
  );

  it("falls back to the legacy main value when an auxiliary value is absent", () => {
    const legacy = {
      ollamaModel: "legacy-local",
      ollamaCloudModel: "legacy-cloud",
    };

    expect(resolveOllamaRequestModel(legacy, "local", "submodel")).toBe(
      "legacy-local",
    );
    expect(resolveOllamaRequestModel(legacy, "cloud", "submodel")).toBe(
      "legacy-cloud",
    );
  });

  it("applies per-feature mode overrides when provided", () => {
    const memoryOverride = {
      ollamaModel: "local-himoi",
      ollamaCloudModel: "cloud-himoi",
    };
    const translateOverride = {
      ollamaModel: "local-gemma4",
      ollamaCloudModel: "cloud-gemma4",
    };

    // Memory uses HiMOI override
    expect(
      resolveOllamaRequestModel(settings, "cloud", "memory", memoryOverride),
    ).toBe("cloud-himoi");
    expect(
      resolveOllamaRequestModel(settings, "local", "memory", memoryOverride),
    ).toBe("local-himoi");

    // Translate uses Gemma4 override
    expect(
      resolveOllamaRequestModel(
        settings,
        "cloud",
        "translate",
        translateOverride,
      ),
    ).toBe("cloud-gemma4");
    expect(
      resolveOllamaRequestModel(
        settings,
        "local",
        "translate",
        translateOverride,
      ),
    ).toBe("local-gemma4");

    // Without override, falls back to auxiliary setting
    expect(
      resolveOllamaRequestModel(settings, "cloud", "emotion", undefined),
    ).toBe("cloud-aux");
  });
});
