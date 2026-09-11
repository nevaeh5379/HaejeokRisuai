import { describe, expect, it, vi } from "vitest";
import {
  buildSqliteColdStorageDelete,
  findSqliteColdStoragePruneKeys,
  getSqliteColdStorageItem,
  getSqliteRevisionDetails,
  getSqliteRevisionDiff,
  listSqlitePluginCustomStorageKeys,
  listSqliteRevisions,
  loadSqlitePluginCustomStorage,
  loadSqlitePluginCustomStorageKey,
  previewSqliteRevisionRestore,
  type SqliteLoadNodeValue,
} from "@risuai/storage-sqlite/sqlitePersistenceQueries";
import type { SqliteSelectRows } from "@risuai/storage-sqlite/sqliteAdminQueries";

describe("SQLite persistence queries", () => {
  it("decodes plugin custom storage while preserving legacy text", async () => {
    const selectRows = vi.fn(async () => [
      { key: "json", value: '{"enabled":true}' },
      { key: "text", value: "legacy" },
    ]) as unknown as SqliteSelectRows;
    expect(await loadSqlitePluginCustomStorage(selectRows)).toEqual({
      json: { enabled: true },
      text: "legacy",
    });
    expect(await listSqlitePluginCustomStorageKeys(selectRows)).toEqual([
      "json",
      "text",
    ]);
    expect(await loadSqlitePluginCustomStorageKey(selectRows, "json")).toEqual({
      enabled: true,
    });
  });

  it("loads cold storage lazily and builds bounded deletion statements", async () => {
    const selectRows = vi.fn(async () => [
      { archive_id: "cold-a" },
    ]) as unknown as SqliteSelectRows;
    const loadNodeValue = vi.fn(async () => ({
      archived: true,
    })) as SqliteLoadNodeValue;
    await expect(
      getSqliteColdStorageItem(selectRows, loadNodeValue, "cold-a"),
    ).resolves.toEqual({ archived: true });
    expect(loadNodeValue).toHaveBeenCalledWith(
      "cold_extension_nodes",
      "archive_id = ?",
      ["cold-a"],
    );
    expect(buildSqliteColdStorageDelete(["a", "b"])).toEqual({
      sql: "DELETE FROM cold_archives WHERE archive_id IN (?,?)",
      bind: ["a", "b"],
    });
    expect(buildSqliteColdStorageDelete([])).toBeNull();
  });

  it("prunes only unretained cold storage keys", async () => {
    const selectRows = vi.fn(async () => [
      { archive_id: "keep" },
      { archive_id: "drop-a" },
      { archive_id: "drop-b" },
    ]) as unknown as SqliteSelectRows;
    await expect(
      findSqliteColdStoragePruneKeys(selectRows, ["keep"]),
    ).resolves.toEqual(["drop-a", "drop-b"]);
  });

  it("maps revision history through the shared SQLite contract", async () => {
    const row = {
      id: 7,
      storage_revision: 11,
      database_initialized: 1,
      scope: "database",
      action: "commit",
      restored_from_revision: null,
      created_at: "2026-09-10T00:00:00.000Z",
    };
    const selectRows = vi.fn(async () => [row]) as unknown as SqliteSelectRows;
    const revisions = await listSqliteRevisions(selectRows, 5);
    expect(revisions[0]).toMatchObject({
      id: 7,
      storage_revision: 11,
      database_initialized: true,
      action: "commit",
      change_count: 0,
    });
    expect(selectRows).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT ?"),
      [5],
    );
    await expect(
      getSqliteRevisionDetails(selectRows, 7),
    ).resolves.toMatchObject({
      id: 7,
      tableSummaries: [],
      auditLogs: [],
    });
  });

  it("builds local revision diff and restore previews without backend I/O", () => {
    expect(getSqliteRevisionDiff(3, 8)).toEqual({
      baseRevisionId: 3,
      targetRevisionId: 8,
      totalChanges: 0,
      tables: [],
    });
    expect(previewSqliteRevisionRestore(12, 9)).toMatchObject({
      targetRevisionId: 9,
      currentRevisionId: 12,
      revisionsToRevert: 3,
      totalOperations: 0,
    });
  });
});
