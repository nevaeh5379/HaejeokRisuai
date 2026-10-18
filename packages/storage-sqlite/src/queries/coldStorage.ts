import type {
  SqliteLoadNodeValue,
  SqliteSelectRows,
  SqliteStatement,
} from "../types";

export async function getItem(
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

export async function listItems(
  selectRows: SqliteSelectRows,
): Promise<{ items: string[] }> {
  const rows = await selectRows<{ archive_id: string }>(
    "SELECT archive_id FROM cold_archives",
  );
  return { items: rows.map((row) => row.archive_id) };
}

export function buildDelete(keys: string[]): SqliteStatement | null {
  if (keys.length === 0) return null;
  return {
    sql: `DELETE FROM cold_archives WHERE archive_id IN (${keys.map(() => "?").join(",")})`,
    bind: keys,
  };
}

export async function findPruneKeys(
  selectRows: SqliteSelectRows,
  retainedKeys: readonly string[],
): Promise<string[]> {
  const retained = new Set(retainedKeys);
  const rows = await selectRows<{ archive_id: string }>(
    "SELECT archive_id FROM cold_archives",
  );
  return rows.map((row) => row.archive_id).filter((key) => !retained.has(key));
}
