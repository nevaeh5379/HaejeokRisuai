import { describe, expect, it, vi } from "vitest";
import * as sqliteColdStorage from "@risuai/storage-sqlite/queries/coldStorage";
import * as sqlitePlugin from "@risuai/storage-sqlite/queries/plugin";
import * as sqliteRevisions from "@risuai/storage-sqlite/queries/revisions";
import type {
  SqliteLoadNodeValue,
  SqliteSelectRows,
} from "@risuai/storage-sqlite/types";

describe("SQLite persistence queries", () => {
  it("decodes plugin custom storage while preserving legacy text", async () => {
    const selectRows = vi.fn(async () => [
      { key: "json", value: '{"enabled":true}' },
      { key: "text", value: "legacy" },
    ]) as unknown as SqliteSelectRows;
    expect(await sqlitePlugin.loadCustomStorage(selectRows)).toEqual({
      json: { enabled: true },
      text: "legacy",
    });
    expect(await sqlitePlugin.listCustomStorageKeys(selectRows)).toEqual([
      "json",
      "text",
    ]);
    expect(await sqlitePlugin.loadCustomStorageKey(selectRows, "json")).toEqual(
      {
        enabled: true,
      },
    );
  });

  it("loads cold storage lazily and builds bounded deletion statements", async () => {
    const selectRows = vi.fn(async () => [
      { archive_id: "cold-a" },
    ]) as unknown as SqliteSelectRows;
    const loadNodeValue = vi.fn(async () => ({
      archived: true,
    })) as SqliteLoadNodeValue;
    await expect(
      sqliteColdStorage.getItem(selectRows, loadNodeValue, "cold-a"),
    ).resolves.toEqual({ archived: true });
    expect(loadNodeValue).toHaveBeenCalledWith(
      "cold_extension_nodes",
      "archive_id = ?",
      ["cold-a"],
    );
    expect(sqliteColdStorage.buildDelete(["a", "b"])).toEqual({
      sql: "DELETE FROM cold_archives WHERE archive_id IN (?,?)",
      bind: ["a", "b"],
    });
    expect(sqliteColdStorage.buildDelete([])).toBeNull();
  });

  it("prunes only unretained cold storage keys", async () => {
    const selectRows = vi.fn(async () => [
      { archive_id: "keep" },
      { archive_id: "drop-a" },
      { archive_id: "drop-b" },
    ]) as unknown as SqliteSelectRows;
    await expect(
      sqliteColdStorage.findPruneKeys(selectRows, ["keep"]),
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
    const revisions = await sqliteRevisions.list(selectRows, 5);
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
      sqliteRevisions.getDetails(selectRows, 7),
    ).resolves.toMatchObject({
      id: 7,
      tableSummaries: [],
      auditLogs: [],
    });
  });

  it("builds local revision diff and restore previews without backend I/O", () => {
    expect(sqliteRevisions.getDiff(3, 8)).toEqual({
      baseRevisionId: 3,
      targetRevisionId: 8,
      totalChanges: 0,
      tables: [],
    });
    expect(sqliteRevisions.previewRestore(12, 9)).toMatchObject({
      targetRevisionId: 9,
      currentRevisionId: 12,
      revisionsToRevert: 3,
      totalOperations: 0,
    });
  });
});
