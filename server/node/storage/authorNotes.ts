import { loadMssql, loadOracle } from "./../util/runtimeModules.ts";
import * as notes from "../../../packages/protocol/src/authorNoteSql.ts";
import type { AuthorNoteSql } from "../../../packages/protocol/src/authorNoteSql.ts";

/** All values are bound; this adapter owns only dialect conversion, never transaction lifetime. */
function authorNoteDatabase(
  vendor: "postgres" | "oracle" | "azure",
  client?: any,
): AuthorNoteSql {
  const run = async (sql: string, values: unknown[] = []) => {
    let index = 0;
    const converted = sql.replace(/\?/g, () =>
      vendor === "postgres"
        ? `$${++index}`
        : vendor === "oracle"
          ? `:${++index}`
          : `@p${++index}`,
    );
    if (vendor === "postgres")
      return (await client.query(converted, values)).rows;
    if (vendor === "azure") {
      const request = client.request();
      const mssql = await loadMssql();
      values.forEach((value, i) =>
        request.input(
          `p${i + 1}`,
          typeof value === "number"
            ? mssql.BigInt
            : typeof value === "boolean"
              ? mssql.Bit
              : mssql.NVarChar(mssql.MAX),
          value,
        ),
      );
      return (await request.query(converted)).recordset ?? [];
    }
    const oracle = await loadOracle();
    // Author note CLOBs must retain actual bytes, including NUL and empty content.
    // Bypass the legacy connection's empty-string sentinel adapter.
    const rawClient = client.__risuRawConnection ?? client;
    const binds = values.map((value, i) => {
      const clob = /INSERT INTO global_author_notes/.test(sql)
        ? i === 1 || i === 2
        : /UPDATE global_author_notes SET (?:name|content) =/.test(sql)
          ? i === 0
          : /UPDATE system_revisions SET note_commit_key/.test(sql) && i === 2;
      return clob
        ? { val: value === "" ? null : value, type: oracle.CLOB }
        : value;
    });
    const result = await rawClient.execute(converted, binds, {
      outFormat: oracle.OUT_FORMAT_OBJECT,
      fetchInfo: {
        CONTENT: { type: oracle.STRING },
        NAME: { type: oracle.STRING },
        NOTE_COMMIT_RESULT: { type: oracle.STRING },
      },
    });
    return (result.rows ?? []).map((row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]),
      ),
    );
  };
  return {
    dialect: vendor,
    query: run,
    execute: async (sql, bind) => {
      await run(sql, bind);
    },
  };
}
async function withAuthorNoteDatabase<T>(
  storage: any,
  vendor: "postgres" | "oracle" | "azure",
  task: (db: AuthorNoteSql) => Promise<T>,
): Promise<T> {
  storage.assertEnabled?.();
  const client =
    vendor === "postgres"
      ? await storage.pool.connect()
      : vendor === "oracle"
        ? await storage.pool.getConnection()
        : await storage.getPool();
  try {
    return await task(authorNoteDatabase(vendor, client));
  } finally {
    if (vendor === "postgres") client.release();
    else if (vendor === "oracle") await client.close();
  }
}
export type AuthorNotesAdapter = {
  notes: typeof notes;
  authorNoteDatabase: typeof authorNoteDatabase;
  withAuthorNoteDatabase: typeof withAuthorNoteDatabase;
};
export { notes, authorNoteDatabase, withAuthorNoteDatabase };
