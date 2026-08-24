import { describe, expect, it } from "vitest";
import { prepareLoreEntriesForServer } from "./loreServerPrepare";

const options = {
  scanDepth: 8,
  fullWordMatching: false,
  recursiveScanning: true,
  chatLength: 12,
  greetingIndex: 1,
};

function lore(overrides: Record<string, unknown> = {}) {
  return {
    key: "moon",
    comment: "Moon lore",
    content: "The dragon sleeps",
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
    useRegex: false,
    ...overrides,
  } as any;
}

describe("prepareLoreEntriesForServer", () => {
  it("prepares recursive matching metadata", () => {
    const result = prepareLoreEntriesForServer(
      [lore({ content: "@@scan_depth 3\n@@recursive\nThe dragon sleeps" })],
      options,
    );

    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      scanDepth: 3,
      recursive: true,
      content: "The dragon sleeps",
      source: "Moon lore",
    });
  });

  it("falls back for stateful probability directives", () => {
    const result = prepareLoreEntriesForServer(
      [lore({ content: "@@probability 50\nMaybe active" })],
      options,
    );
    expect(result).toBeNull();
  });

  it("falls back when child lore is present", () => {
    const result = prepareLoreEntriesForServer(
      [lore({ mode: "child", id: "shared" })],
      options,
    );
    expect(result).toBeNull();
  });
});
