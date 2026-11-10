import { sql, type Transaction } from "kysely";
import type { PostgresDatabase } from "../type.ts";

export type RevisionAction =
  | "character:create"
  | "character:update"
  | "chat:create"
  | "chat:delete";

export async function beginRevision(
  trx: Transaction<PostgresDatabase>,
  action: RevisionAction,
): Promise<void> {
  await sql`select system.character_begin_revision(${action})`.execute(trx);
}
