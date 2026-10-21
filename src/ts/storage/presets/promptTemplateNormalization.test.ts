import { describe, expect, it } from "vitest";
import { normalizePromptTemplate } from "./promptTemplateNormalization";
import type { PromptItem, PromptItemPlain } from "../../process/prompt";

describe("normalizePromptTemplate optimization", () => {
  it("returns null when template is not an array", () => {
    expect(normalizePromptTemplate(null)).toBeNull();
    expect(normalizePromptTemplate(undefined)).toBeNull();
  });

  it("returns the exact same array reference when already normalized (0 allocations)", () => {
    const template: PromptItem[] = [
      {
        type: "plain",
        type2: "normal",
        text: "You are an assistant.",
        role: "system",
      },
      {
        type: "plain",
        type2: "normal",
        text: "{{user}}: Hello",
        role: "user",
      },
      {
        type: "plain",
        type2: "normal",
        text: "{{char}}: Hi there",
        role: "bot",
      },
      { type: "persona", role2: "system" },
      { type: "cache", name: "cache1", depth: 0, role: "assistant" },
    ];

    const result = normalizePromptTemplate(template);
    expect(result).toBe(template); // Same reference!
  });

  it("normalizes legacy roles and returns a new cloned array when changes are needed", () => {
    const legacyTemplate = [
      {
        type: "plain",
        type2: "normal",
        text: "Old char role",
        role: "char",
      },
      {
        type: "plain",
        type2: "normal",
        text: "Old assistant role",
        role: "assistant",
      },
      { type: "persona", role2: "char" },
      { type: "cache", name: "cache1", depth: 0, role: "bot" },
    ] as unknown as PromptItem[];

    const result = normalizePromptTemplate(legacyTemplate);
    expect(result).not.toBe(legacyTemplate);
    expect(result).toEqual([
      {
        type: "plain",
        type2: "normal",
        text: "Old char role",
        role: "bot",
      },
      {
        type: "plain",
        type2: "normal",
        text: "Old assistant role",
        role: "bot",
      },
      { type: "persona", role2: "bot" },
      { type: "cache", name: "cache1", depth: 0, role: "assistant" },
    ]);
    // Ensure original template is untouched
    expect((legacyTemplate[0] as PromptItemPlain).role).toBe("char");
  });

  it("defaults invalid roles to system", () => {
    const legacyTemplate = [
      {
        type: "plain",
        type2: "normal",
        text: "Test",
        role: "unknown_role",
      },
    ] as unknown as PromptItem[];
    const result = normalizePromptTemplate(legacyTemplate);
    expect(result).not.toBe(legacyTemplate);
    expect((result![0] as PromptItemPlain).role).toBe("system");
  });
});
