import { describe, expect, it } from "vitest";

import {
  getProviderModeOverride,
  isAuxiliaryProviderMode,
  isProviderFeatureMode,
  resolveProviderRoleModel,
  resolveProviderRoleModelForMode,
  resolveProviderRoleSetting,
  resolveProviderRoleSettingForMode,
} from "./providerRoleSettings";

describe("provider role settings", () => {
  it.each(["submodel", "memory", "emotion", "otherAx", "translate"] as const)(
    "treats %s as an auxiliary request",
    (mode) => {
      expect(isAuxiliaryProviderMode(mode)).toBe(true);
      expect(resolveProviderRoleSetting("main", "aux", mode)).toBe("aux");
    },
  );

  it("uses main settings for main and unspecified request modes", () => {
    expect(resolveProviderRoleSetting("main", "aux", "model")).toBe("main");
    expect(resolveProviderRoleSetting("main", "aux")).toBe("main");
  });

  it("falls back only when an auxiliary setting is absent", () => {
    expect(resolveProviderRoleSetting("main", undefined, "submodel")).toBe(
      "main",
    );
    expect(resolveProviderRoleSetting("main", "", "submodel")).toBe("");
    expect(resolveProviderRoleSetting(true, false, "submodel")).toBe(false);
  });

  it("falls back from an empty auxiliary model without changing valid empty options", () => {
    expect(resolveProviderRoleModel("main", "", "submodel")).toBe("main");
    expect(resolveProviderRoleSetting("provider", "", "submodel")).toBe("");
  });

  it("supports per-feature model overrides for auxiliary modes", () => {
    expect(
      resolveProviderRoleModelForMode(
        "main-model",
        "sub-model",
        "memory",
        "override-memory-model",
      ),
    ).toBe("override-memory-model");

    expect(
      resolveProviderRoleModelForMode(
        "main-model",
        "sub-model",
        "translate",
        "override-translate-model",
      ),
    ).toBe("override-translate-model");

    // Falls back to sub-model when override is not specified
    expect(
      resolveProviderRoleModelForMode(
        "main-model",
        "sub-model",
        "emotion",
        undefined,
      ),
    ).toBe("sub-model");

    // Ignores override when mode is 'model' (main)
    expect(
      resolveProviderRoleModelForMode(
        "main-model",
        "sub-model",
        "model",
        "override-model",
      ),
    ).toBe("main-model");
  });

  it("supports per-feature setting overrides for auxiliary modes", () => {
    expect(
      resolveProviderRoleSettingForMode(false, false, "memory", true),
    ).toBe(true);

    expect(
      resolveProviderRoleSettingForMode(
        "main-provider",
        "sub-provider",
        "translate",
        "override-provider",
      ),
    ).toBe("override-provider");
  });

  it.each(["memory", "emotion", "otherAx", "translate"] as const)(
    "recognizes %s as a provider feature mode",
    (mode) => {
      expect(isProviderFeatureMode(mode)).toBe(true);
    },
  );

  it("returns provider overrides only for enabled feature modes", () => {
    const overrides = {
      memory: { model: "memory-model" },
      emotion: { model: "emotion-model" },
    };

    expect(getProviderModeOverride(true, overrides, "memory")).toEqual({
      model: "memory-model",
    });
    expect(getProviderModeOverride(false, overrides, "memory")).toBeUndefined();
    expect(getProviderModeOverride(true, overrides, "model")).toBeUndefined();
    expect(
      getProviderModeOverride(true, overrides, "submodel"),
    ).toBeUndefined();
  });
});
