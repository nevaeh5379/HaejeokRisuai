import { beforeEach, describe, expect, it } from "vitest";

const {
  syncVectorIndex,
  upsertVectorIndex,
  searchVectorIndex,
  clearVectorIndexes,
} = require("./vectorIndex.cjs");

describe("vectorIndex", () => {
  beforeEach(() => clearVectorIndexes());

  it("requests missing vectors and reuses matching signatures", () => {
    expect(
      syncVectorIndex("chat-1", [
        { id: "a", signature: "one" },
        { id: "b", signature: "two" },
      ]).missingIds,
    ).toEqual(["a", "b"]);

    upsertVectorIndex("chat-1", [
      { id: "a", signature: "one", embedding: [1, 0] },
      { id: "b", signature: "two", embedding: [0, 1] },
    ]);

    expect(syncVectorIndex("chat-1", [
      { id: "a", signature: "one" },
      { id: "b", signature: "two" },
    ]).missingIds).toEqual([]);
  });

  it("ranks vectors by cosine similarity", () => {
    syncVectorIndex("chat-2", [
      { id: "x", signature: "x" },
      { id: "y", signature: "y" },
    ]);
    upsertVectorIndex("chat-2", [
      { id: "x", signature: "x", embedding: [1, 0] },
      { id: "y", signature: "y", embedding: [0, 1] },
    ]);

    const result = searchVectorIndex("chat-2", [[0.9, 0.1]]);
    expect(result?.[0][0][0]).toBe("x");
    expect(result?.[0][0][1]).toBeGreaterThan(result?.[0][1][1]);
  });

  it("invalidates a vector when its signature changes", () => {
    syncVectorIndex("chat-3", [{ id: "x", signature: "old" }]);
    upsertVectorIndex("chat-3", [
      { id: "x", signature: "old", embedding: [1, 0] },
    ]);
    expect(
      syncVectorIndex("chat-3", [{ id: "x", signature: "new" }]).missingIds,
    ).toEqual(["x"]);
  });
});
