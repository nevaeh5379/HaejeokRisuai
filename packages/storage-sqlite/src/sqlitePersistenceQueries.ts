import type {
  NodePostgresRestorePreview,
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
} from "@risuai/protocol/databaseApi.cjs";
import {
  normalizeSqliteLimit,
  type SqliteTransactionStatement,
} from "./sqliteQueries";
import type { SqliteSelectRows } from "./sqliteAdminQueries";

export type SqliteLoadNodeValue = (
  table: string,
  ownerWhere: string,
  bind: unknown[],
) => Promise<unknown>;

export async function loadSqlitePluginCustomStorage(
  selectRows: SqliteSelectRows,
): Promise<Record<string, unknown> | null> {
  const rows = await selectRows<{ key: string; value: string }>(
    "SELECT key, value FROM plugin_custom_storage",
  );
  if (rows.length === 0) return null;
  const storage: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      storage[row.key] = JSON.parse(row.value);
    } catch {
      storage[row.key] = row.value;
    }
  }
  return storage;
}

export async function listSqlitePluginCustomStorageKeys(
  selectRows: SqliteSelectRows,
): Promise<string[]> {
  const rows = await selectRows<{ key: string }>(
    "SELECT key FROM plugin_custom_storage ORDER BY key",
  );
  return rows.map((row) => row.key);
}

export async function loadSqlitePluginCustomStorageKey(
  selectRows: SqliteSelectRows,
  key: string,
): Promise<unknown> {
  const rows = await selectRows<{ value: string }>(
    "SELECT value FROM plugin_custom_storage WHERE key = ?",
    [key],
  );
  const row = rows[0];
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function getSqliteColdStorageItem(
  selectRows: SqliteSelectRows,
  loadNodeValue: SqliteLoadNodeValue,
  key: string,
): Promise<unknown | null> {
  const rows = await selectRows<{ archive_id: string }>(
    "SELECT archive_id FROM cold_archives WHERE archive_id = ?",
    [key],
  );
  return rows[0]
    ? loadNodeValue("cold_extension_nodes", "archive_id = ?", [key])
    : null;
}

export async function listSqliteColdStorageItems(
  selectRows: SqliteSelectRows,
): Promise<{ items: string[] }> {
  const rows = await selectRows<{ archive_id: string }>(
    "SELECT archive_id FROM cold_archives",
  );
  return { items: rows.map((row) => row.archive_id) };
}

export function buildSqliteColdStorageDelete(
  keys: string[],
): SqliteTransactionStatement | null {
  if (keys.length === 0) return null;
  return {
    sql: `DELETE FROM cold_archives WHERE archive_id IN (${keys.map(() => "?").join(",")})`,
    bind: keys,
  };
}

export async function findSqliteColdStoragePruneKeys(
  selectRows: SqliteSelectRows,
  retainedKeys: readonly string[],
): Promise<string[]> {
  const retained = new Set(retainedKeys);
  const rows = await selectRows<{ archive_id: string }>(
    "SELECT archive_id FROM cold_archives",
  );
  return rows.map((row) => row.archive_id).filter((key) => !retained.has(key));
}

type SqliteRevisionRow = {
  id: number;
  storage_revision: number | null;
  database_initialized: number | null;
  scope: string;
  action: string;
  restored_from_revision: number | null;
  created_at: string;
};

function mapRevision(row: SqliteRevisionRow): NodePostgresRevision {
  return {
    id: Number(row.id),
    storage_revision:
      row.storage_revision != null ? Number(row.storage_revision) : null,
    database_initialized:
      row.database_initialized != null
        ? Boolean(row.database_initialized)
        : null,
    scope: row.scope as "database" | "cold-storage" | "restore",
    action: row.action,
    restored_from_revision:
      row.restored_from_revision != null
        ? Number(row.restored_from_revision)
        : null,
    created_at: row.created_at,
    change_count: 0,
  };
}

export async function listSqliteRevisions(
  selectRows: SqliteSelectRows,
  limit?: number,
): Promise<NodePostgresRevision[]> {
  const normalizedLimit =
    limit !== undefined && Number.isFinite(limit) && limit > 0
      ? normalizeSqliteLimit(limit)
      : undefined;
  const sql =
    "SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions ORDER BY created_at DESC, id DESC" +
    (normalizedLimit !== undefined ? " LIMIT ?" : "");
  const rows = await selectRows<SqliteRevisionRow>(
    sql,
    normalizedLimit !== undefined ? [normalizedLimit] : [],
  );
  return rows.map(mapRevision);
}

export async function getSqliteRevisionDetails(
  selectRows: SqliteSelectRows,
  revisionId: number,
): Promise<NodePostgresRevisionDetails | null> {
  const rows = await selectRows<SqliteRevisionRow>(
    "SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions WHERE id = ?",
    [revisionId],
  );
  if (rows.length === 0) return null;
  return {
    ...mapRevision(rows[0]),
    tableSummaries: [],
    auditLogs: [],
  };
}

export function getSqliteRevisionDiff(
  baseId: number,
  targetId: number,
): NodePostgresRevisionDiff {
  return {
    baseRevisionId: baseId,
    targetRevisionId: targetId,
    totalChanges: 0,
    tables: [],
  };
}

export function previewSqliteRevisionRestore(
  currentRevision: number,
  revisionId: number,
): NodePostgresRestorePreview {
  return {
    targetRevisionId: revisionId,
    currentRevisionId: currentRevision,
    revisionsToRevert: Math.max(0, currentRevision - revisionId),
    totalOperations: 0,
    restoreInsertCount: 0,
    restoreDeleteCount: 0,
    restoreUpdateCount: 0,
    affectedTables: [],
  };
}
