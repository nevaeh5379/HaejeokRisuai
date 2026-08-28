import { describe, expect, it } from "vitest";

import {
  isAuxiliaryProviderMode,
  resolveProviderRoleModel,
  resolveProviderRoleSetting,
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
});
