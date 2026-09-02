import { describe, expect, it } from "vitest";
import {
  getNextFirstMessageIndex,
  getPreviousFirstMessageIndex,
  getSelectedFirstMessage,
  normalizeFirstMessageIndex,
} from "./firstMessageSelection";

describe("first message selection", () => {
  it.each([undefined, null, Number.NaN, 2, -2, 0.5])(
    "normalizes an invalid index (%s) to the default greeting",
    (index) => {
      expect(normalizeFirstMessageIndex(index, 2)).toBe(-1);
      expect(getSelectedFirstMessage("default", ["alt 1", "alt 2"], index)).toBe(
        "default",
      );
    },
  );

  it("cycles forward from a missing index without producing NaN", () => {
    expect(getNextFirstMessageIndex(undefined, 2)).toBe(0);
    expect(getNextFirstMessageIndex(0, 2)).toBe(1);
    expect(getNextFirstMessageIndex(1, 2)).toBe(-1);
  });

  it("cycles backward from a missing index", () => {
    expect(getPreviousFirstMessageIndex(undefined, 2)).toBe(1);
    expect(getPreviousFirstMessageIndex(1, 2)).toBe(0);
    expect(getPreviousFirstMessageIndex(0, 2)).toBe(-1);
    expect(getPreviousFirstMessageIndex(undefined, 0)).toBe(-1);
  });
});
