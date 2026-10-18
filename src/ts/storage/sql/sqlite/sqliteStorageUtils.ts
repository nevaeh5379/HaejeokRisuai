import * as sqliteMessages from "@risuai/storage-sqlite/queries/messages";
import type { Message } from "../../database/schema";

export function rebuildMessageRows(rows: Record<string, unknown>[]): Message[] {
  return sqliteMessages.rebuildRows<Message>(rows);
}

export function rebuildBranchGraphMessages(
  rows: Record<string, unknown>[],
): Message[] {
  return sqliteMessages.rebuildGraphMessages<Message>(rows);
}
