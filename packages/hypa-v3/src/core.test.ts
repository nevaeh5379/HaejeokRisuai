import { describe, expect, it } from "vitest";
import {
  childToParentRRF,
  cleanOrphanedSummaries,
  combineScoredLists,
  deserializeHypaV3Data,
  normalizeScores,
  reciprocalRankFusion,
  serializeHypaV3Data,
} from "./core.js";
import { createHypaV3Preset } from "./preset.js";

describe("Hypa V3 portable core", () => {
  it("round-trips memory without retaining the legacy selection field", () => {
    const memory = deserializeHypaV3Data({
      lastSelectedSummaries: [0],
      summaries: [
        { text: "summary", chatMemos: ["a", "b"], isImportant: false },
      ],
    });

    expect(memory.lastSelectedSummaries).toBeUndefined();
    expect(memory.summaries[0].chatMemos).toEqual(new Set(["a", "b"]));
    expect(serializeHypaV3Data(memory).summaries[0].chatMemos).toEqual([
      "a",
      "b",
    ]);
  });

  it("removes summaries referring to chats that no longer exist", () => {
    const memory = deserializeHypaV3Data({
      summaries: [
        { text: "keep", chatMemos: ["a"], isImportant: false },
        { text: "drop", chatMemos: ["missing"], isImportant: false },
      ],
    });

    expect(cleanOrphanedSummaries(["a"], memory)).toBe(1);
    expect(memory.summaries.map((summary) => summary.text)).toEqual(["keep"]);
  });

  it("preserves the existing ranking behavior", () => {
    expect(combineScoredLists([[['a', 1], ['b', 0.2]]])).toEqual(['a', 'b']);
    expect(reciprocalRankFusion([["a", "b"], ["b", "a"]])).toEqual([
      "a",
      "b",
    ]);
    expect(childToParentRRF(["a1", "a2", "b1"], (item) => item[0])).toEqual([
      "a",
      "b",
    ]);
    expect(normalizeScores([["low", 2], ["high", 4]])).toEqual([
      ["low", 0],
      ["high", 1],
    ]);
  });

  it("accepts only known preset fields with matching runtime types", () => {
    const preset = createHypaV3Preset("test", {
      queryChatCount: 5,
      memoryTokensRatio: "invalid" as unknown as number,
    });
    expect(preset.settings.queryChatCount).toBe(5);
    expect(preset.settings.memoryTokensRatio).toBe(0.2);
  });
});
