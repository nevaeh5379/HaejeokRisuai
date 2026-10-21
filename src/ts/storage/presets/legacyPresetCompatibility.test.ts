import { describe, expect, it } from "vitest";
import {
  readLegacyPresetFields,
  writeLegacyPresetFields,
} from "./legacyPresetCompatibility";

describe("legacyPresetCompatibility optimization", () => {
  it("reads legacy preset fields and deletes legacy keys", () => {
    const root = {
      NAIsettings: { model: "kayra" },
      presetRegex: [{ comment: "test" }],
      reasoningEffort: 5,
    };
    readLegacyPresetFields(root);
    expect(root).toEqual({
      NAISettings: { model: "kayra" },
      regex: [{ comment: "test" }],
      reasonEffort: 5,
    });
    expect((root as any).NAIsettings).toBeUndefined();
    expect((root as any).presetRegex).toBeUndefined();
    expect((root as any).reasoningEffort).toBeUndefined();
  });

  it("writes legacy preset fields into a shallow copy", () => {
    const root = {
      NAISettings: { model: "kayra" },
      regex: [{ comment: "test" }],
      reasonEffort: 5,
      otherField: "keep",
    };
    const result = writeLegacyPresetFields(root);
    expect(result).toEqual({
      NAIsettings: { model: "kayra" },
      presetRegex: [{ comment: "test" }],
      reasoningEffort: 5,
      otherField: "keep",
    });
    // Ensure original is untouched
    expect(root.NAISettings).toBeDefined();
    expect((root as any).NAIsettings).toBeUndefined();
  });
});
