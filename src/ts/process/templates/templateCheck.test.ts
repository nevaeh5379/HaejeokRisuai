import { describe, expect, it } from "vitest";
import type { PromptItem } from "../prompt";
import { templateCheck } from "./templateCheck";

describe("templateCheck", () => {
  it("checks the preset-owned prompt template directly", () => {
    const promptTemplate = [
      { type: "plain", type2: "main" },
      { type: "plain", type2: "globalNote" },
      { type: "description" },
      { type: "lorebook" },
      { type: "chat", rangeStart: 0, rangeEnd: "end" },
    ] as PromptItem[];

    expect(templateCheck(promptTemplate)).toEqual([]);
  });

  it("accepts a missing prompt template during preset initialization", () => {
    expect(templateCheck(undefined)).toEqual([]);
  });
});
