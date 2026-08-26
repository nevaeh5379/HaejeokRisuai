import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const {
  configureVectorIndexPersistence,
  flushVectorIndexPersistence,
  getVectorIndexCacheStats,
  clearVectorIndexCache,
  checkVectorIndexRevision,
  syncVectorIndex,
  upsertVectorIndex,
  searchVectorIndex,
  clearVectorIndexes,
} = require("./vectorIndex.cjs");

describe("vectorIndex", () => {
  beforeEach(() => {
    configureVectorIndexPersistence(null);
    clearVectorIndexes();
  });

  it("uses a compact revision handshake for warm indexes", () => {
    expect(checkVectorIndexRevision("chat-revision", "rev-a").ready).toBe(false);

    const status = syncVectorIndex(
      "chat-revision",
      [
        { id: "a", signature: "one" },
        { id: "b", signature: "two" },
      ],
      "rev-a",
    );
    expect(status.ready).toBe(false);
    expect(status.missingIds).toEqual(["a", "b"]);

    upsertVectorIndex("chat-revision", [
      { id: "a", signature: "one", embedding: [1, 0] },
      { id: "b", signature: "two", embedding: [0, 1] },
    ]);

    expect(checkVectorIndexRevision("chat-revision", "rev-a")).toMatchObject({
      ready: true,
      missingIds: [],
      size: 2,
    });
    expect(checkVectorIndexRevision("chat-revision", "rev-b").ready).toBe(false);
  });

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

  it("returns only the requested top K vectors", () => {
    syncVectorIndex("chat-topk", [
      { id: "a", signature: "a" },
      { id: "b", signature: "b" },
      { id: "c", signature: "c" },
    ]);
    upsertVectorIndex("chat-topk", [
      { id: "a", signature: "a", embedding: [1, 0] },
      { id: "b", signature: "b", embedding: [0.8, 0.2] },
      { id: "c", signature: "c", embedding: [0, 1] },
    ]);

    const result = searchVectorIndex("chat-topk", [[1, 0]], "cosine", 2);
    expect(result?.[0]).toHaveLength(2);
    expect(result?.[0].map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("supports legacy dot-product ranking separately from cosine", () => {
    syncVectorIndex("chat-dot", [
      { id: "large", signature: "large" },
      { id: "aligned", signature: "aligned" },
    ]);
    upsertVectorIndex("chat-dot", [
      { id: "large", signature: "large", embedding: [10, 10] },
      { id: "aligned", signature: "aligned", embedding: [1, 0] },
    ]);

    const cosine = searchVectorIndex("chat-dot", [[1, 0]], "cosine");
    const dot = searchVectorIndex("chat-dot", [[1, 0]], "dot");
    expect(cosine?.[0][0][0]).toBe("aligned");
    expect(dot?.[0][0][0]).toBe("large");
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

  it("restores a completed index from the persistent binary cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "risu-vector-index-"));
    try {
      configureVectorIndexPersistence(directory);
      syncVectorIndex(
        "persistent-chat",
        [
          { id: "a", signature: "one" },
          { id: "b", signature: "two" },
        ],
        "persistent-revision",
      );
      upsertVectorIndex("persistent-chat", [
        { id: "a", signature: "one", embedding: [1, 0] },
        { id: "b", signature: "two", embedding: [0, 1] },
      ]);
      await flushVectorIndexPersistence();
      expect(await readdir(directory)).toHaveLength(1);

      clearVectorIndexes();
      expect(
        checkVectorIndexRevision("persistent-chat", "persistent-revision"),
      ).toMatchObject({ ready: true, size: 2 });
      expect(
        searchVectorIndex("persistent-chat", [[0.95, 0.05]])?.[0][0][0],
      ).toBe("a");

      expect(
        syncVectorIndex("persistent-chat", [
          { id: "a", signature: "one" },
          { id: "b", signature: "changed" },
        ]).missingIds,
      ).toEqual(["b"]);
    } finally {
      configureVectorIndexPersistence(null);
      clearVectorIndexes();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports and clears persistent caches by authenticated scope prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "risu-vector-scope-"));
    try {
      configureVectorIndexPersistence(directory);
      for (const indexId of ["scope-a:first", "scope-a:second", "scope-b:first"]) {
        syncVectorIndex(indexId, [{ id: "x", signature: "same" }], "rev");
        upsertVectorIndex(indexId, [
          { id: "x", signature: "same", embedding: [1, 0, 0] },
        ]);
      }
      await flushVectorIndexPersistence();

      const before = await getVectorIndexCacheStats("scope-a:");
      expect(before.memory).toMatchObject({ indexes: 2, vectors: 2 });
      expect(before.disk).toMatchObject({ indexes: 2, vectors: 2 });
      expect(before.disk.bytes).toBeGreaterThan(0);

      const cleared = await clearVectorIndexCache("scope-a:");
      expect(cleared).toMatchObject({
        memoryIndexes: 2,
        memoryVectors: 2,
        diskIndexes: 2,
      });
      expect((await getVectorIndexCacheStats("scope-a:")).disk.indexes).toBe(0);
      expect((await getVectorIndexCacheStats("scope-b:")).disk.indexes).toBe(1);
      expect(checkVectorIndexRevision("scope-b:first", "rev").ready).toBe(true);
    } finally {
      configureVectorIndexPersistence(null);
      clearVectorIndexes();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
