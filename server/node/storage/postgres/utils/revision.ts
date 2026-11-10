import { sql, type Transaction } from "kysely";
import type { PostgresDatabase } from "../type.ts";

export type RevisionAction =
  | "character:create"
  | "character:update"
  | "chat:create"
  | "chat:delete"
  | "chat:move";

/**
 * Locks the single storage metadata row until the transaction commits or rolls back.
 * Serializes operations that acquire this lock or update the metadata row,
 * including beginRevision. Acquire it before reading state used by a write,
 * and perform the read and write within the same transaction.
 * Does not increment the revision or create a revision record.
 * Throws if the storage metadata row is missing.
 * Example usage:
 * await lockStorageRevision(trx);
 */
export async function lockStorageRevision(
  trx: Transaction<PostgresDatabase>,
): Promise<void> {
  await trx
    .selectFrom("system.storage_meta")
    .select("revision")
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function beginRevision(
  trx: Transaction<PostgresDatabase>,
  action: RevisionAction,
): Promise<void> {
  await sql`select system.character_begin_revision(${action})`.execute(trx);
}
