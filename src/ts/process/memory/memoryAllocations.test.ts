import { describe, expect, it } from "vitest";
import { normalizeScores } from "./hypav3";
import { chunkArray } from "./hypamemory";

describe("normalizeScores", () => {
  it("handles empty lists", () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it("handles all zero scores", () => {
    const list: [string, number][] = [
      ["a", 0],
      ["b", 0],
    ];
    expect(normalizeScores(list)).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("handles identical non-zero scores", () => {
    const list: [string, number][] = [
      ["a", 42],
      ["b", 42],
    ];
    expect(normalizeScores(list)).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("normalizes a range of scores linearly between 0 and 1", () => {
    const list: [string, number][] = [
      ["low", 10],
      ["mid", 20],
      ["high", 30],
    ];
    const normalized = normalizeScores(list);
    expect(normalized).toEqual([
      ["low", 0],
      ["mid", 0.5],
      ["high", 1],
    ]);
  });

  it("handles negative scores properly", () => {
    const list: [string, number][] = [
      ["a", -10],
      ["b", 0],
      ["c", 10],
    ];
    const normalized = normalizeScores(list);
    expect(normalized).toEqual([
      ["a", 0],
      ["b", 0.5],
      ["c", 1],
    ]);
  });
});

describe("chunkArray", () => {
  it("returns single chunk for invalid or non-positive chunk size", () => {
    expect(chunkArray([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunkArray([1, 2, 3], -5)).toEqual([[1, 2, 3]]);
  });

  it("chunks array evenly without mutating original array", () => {
    const original = [1, 2, 3, 4, 5, 6];
    const copy = [...original];
    const chunks = chunkArray(original, 2);
    expect(chunks).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(original).toEqual(copy);
  });

  it("handles uneven remainder chunks", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(chunkArray(items, 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});
