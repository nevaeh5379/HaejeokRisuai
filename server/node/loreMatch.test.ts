import { describe, expect, it } from "vitest";

const { matchLoreBatch, matchLoreRequest } = require("./loreMatch.cjs") as {
  matchLoreRequest: (
    messages: Array<{ role: string; data: string; displayName?: string }>,
    request: Record<string, unknown>,
    options?: Record<string, string>,
  ) => { matched: boolean; logs: Array<{ activated: string }> };
  matchLoreBatch: (
    messages: Array<{ role: string; data: string; displayName?: string }>,
    requests: Array<Record<string, unknown>>,
    options?: Record<string, string>,
  ) => Array<{ matched: boolean }>;
};

const baseRequest = {
  searchDepth: 10,
  regex: false,
  fullWordMatching: false,
};

describe("Node lore matching", () => {
  it("matches partial keys case-insensitively while ignoring spaces", () => {
    const result = matchLoreRequest(
      [{ role: "user", data: "The BIG world is here" }],
      { ...baseRequest, keys: ["bigworld"] },
      { username: "User", charName: "Bot" },
    );
    expect(result.matched).toBe(true);
    expect(result.logs[0]?.activated).toBe("bigworld");
  });
  it("respects scan depth", () => {
    const messages = [
      { role: "user", data: "ancient dragon" },
      { role: "user", data: "quiet village" },
    ];
    expect(
      matchLoreRequest(messages, {
        ...baseRequest,
        keys: ["dragon"],
        searchDepth: 1,
      }).matched,
    ).toBe(false);
    expect(
      matchLoreRequest(messages, {
        ...baseRequest,
        keys: ["dragon"],
        searchDepth: 2,
      }).matched,
    ).toBe(true);
  });

  it("supports full-word and all-key matching", () => {
    expect(
      matchLoreRequest(
        [{ role: "char", data: "cat cathedral", displayName: "Bot" }],
        { ...baseRequest, keys: ["cat"], fullWordMatching: true },
      ).matched,
    ).toBe(true);

    const [allMatched, allMissed] = matchLoreBatch(
      [{ role: "user", data: "alpha beta" }],
      [
        { ...baseRequest, keys: ["alpha", "beta"], all: true },
        { ...baseRequest, keys: ["alpha", "gamma"], all: true },
      ],
    );
    expect(allMatched.matched).toBe(true);
    expect(allMissed.matched).toBe(false);
  });
});
