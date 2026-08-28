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
});
