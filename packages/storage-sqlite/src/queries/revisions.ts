import type {
  NodePostgresRestorePreview,
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
} from "@risuai/protocol/databaseApi.ts";
import type { SqliteSelectRows } from "../types";
import { normalizeLimit } from "../util";

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

export async function list(
  selectRows: SqliteSelectRows,
  limit?: number,
): Promise<NodePostgresRevision[]> {
  const normalizedLimit =
    limit !== undefined && Number.isFinite(limit) && limit > 0
      ? normalizeLimit(limit)
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

export async function getDetails(
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

export function getDiff(
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

export function previewRestore(
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
