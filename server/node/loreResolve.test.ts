import { describe, expect, it } from "vitest";

const { resolveLoreEntries } = require("./loreResolve.cjs") as {
  resolveLoreEntries: (
    messages: unknown[],
    entries: unknown[],
    options?: unknown,
  ) => {
    activatedIndexes: number[];
    logs: Array<{ activated: string }>;
  };
};

const message = { role: "user", data: "The moon is bright" };

function baseEntry(index: number, keys: string[], content: string) {
  return {
    index,
    activated: true,
    alwaysActive: false,
    forceState: "none",
    recursive: true,
    content,
    source: `lore ${index}`,
    regex: false,
    scanDepth: 10,
    fullWordMatching: false,
    dontSearchWhenRecursive: false,
    searchQueries: [{ keys, negative: false }],
  };
}
describe("resolveLoreEntries", () => {
  it("activates lore recursively from earlier lore content", () => {
    const result = resolveLoreEntries(
      [message],
      [
        baseEntry(0, ["moon"], "A silver dragon appears"),
        baseEntry(1, ["dragon"], "The second lore wakes"),
      ],
      { username: "User", charName: "Bot" },
    );

    expect(result.activatedIndexes).toEqual([0, 1]);
    expect(result.logs.map((item) => item.activated)).toEqual([
      "moon",
      "dragon",
    ]);
  });

  it("respects no-recursive-search entries", () => {
    const first = baseEntry(0, ["moon"], "A silver dragon appears");
    const second = {
      ...baseEntry(1, ["dragon"], "Should stay asleep"),
      dontSearchWhenRecursive: true,
    };
    const result = resolveLoreEntries([message], [first, second], {
      username: "User",
      charName: "Bot",
    });
    expect(result.activatedIndexes).toEqual([0]);
  });
});
