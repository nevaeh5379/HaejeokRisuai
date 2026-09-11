export * from "@risuai/storage-sqlite/sqliteQueries";

import {
  rebuildSqliteBranchGraphMessages,
  rebuildSqliteMessageRows,
} from "@risuai/storage-sqlite/sqliteMessageMapper";
import type { Message } from "../../database/schema";

export function rebuildMessageRows(rows: Record<string, unknown>[]): Message[] {
  return rebuildSqliteMessageRows<Message>(rows);
}

export function rebuildBranchGraphMessages(
  rows: Record<string, unknown>[],
): Message[] {
  return rebuildSqliteBranchGraphMessages<Message>(rows);
}
