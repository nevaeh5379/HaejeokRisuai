import {
  AuthorNoteError,
  EMPTY_AUTHOR_NOTE_HASH,
  NO_AUTHOR_NOTE,
  hashAuthorNote,
  parseAuthorNoteOperations,
  type AuthorNoteOperation,
  type AuthorNoteRow,
  type AuthorNoteMetadata,
} from "./authorNotes.ts";

export interface AuthorNoteSql {
  query(sql: string, bind?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, bind?: unknown[]): Promise<void>;
  dialect: "sqlite" | "postgres" | "oracle" | "azure";
}
export function authorNoteTables(db: Pick<AuthorNoteSql, "dialect">) {
  return db.dialect === "postgres"
    ? {
        notes: "system.global_author_notes",
        settings: "system.global_author_note_settings",
      }
    : db.dialect === "azure"
      ? {
          notes: "[system].[global_author_notes]",
          settings: "[system].[global_author_note_settings]",
        }
      : {
          notes: "global_author_notes",
          settings: "global_author_note_settings",
        };
}
function metadata(row: Record<string, unknown>): AuthorNoteMetadata {
  return {
    id: String(row.id),
    name: row.id === NO_AUTHOR_NOTE ? "" : String(row.name ?? ""),
    updatedAt: Number(row.updated_at),
  };
}
export async function listAuthorNotes(
  db: AuthorNoteSql,
): Promise<AuthorNoteMetadata[]> {
  return (
    await db.query(
      `SELECT id, name, updated_at FROM ${authorNoteTables(db).notes} ORDER BY ${db.dialect === "oracle" ? "id" : "name, id"}`,
    )
  )
    .map(metadata)
    .sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
}
export async function getAuthorNote(
  db: AuthorNoteSql,
  id: string,
): Promise<AuthorNoteMetadata | null> {
  const row = (
    await db.query(
      `SELECT id, name, updated_at FROM ${authorNoteTables(db).notes} WHERE id = ?`,
      [id],
    )
  )[0];
  return row ? metadata(row) : null;
}
export async function readAuthorNote(
  db: AuthorNoteSql,
  id: string,
): Promise<AuthorNoteRow | null> {
  const row = (
    await db.query(
      `SELECT id, name, content, content_hash, updated_at FROM ${authorNoteTables(db).notes} WHERE id = ?`,
      [id],
    )
  )[0];
  return row
    ? {
        ...metadata(row),
        content: String(row.content ?? ""),
        contentHash: String(row.content_hash),
      }
    : null;
}
export async function allowAuthorNoteScriptWrite(
  db: AuthorNoteSql,
): Promise<boolean> {
  const row = (
    await db.query(
      `SELECT allow_script_write FROM ${authorNoteTables(db).settings} WHERE singleton = 1`,
    )
  )[0];
  return (
    row?.allow_script_write === true || Number(row?.allow_script_write) === 1
  );
}
export async function exportAuthorNotes(db: AuthorNoteSql) {
  const notes: AuthorNoteRow[] = [];
  for (const entry of await listAuthorNotes(db)) {
    const row = await readAuthorNote(db, entry.id);
    if (!row) throw new AuthorNoteError("missing", entry.id);
    notes.push(row);
  }
  return {
    globalAuthorNotes: notes,
    globalAuthorNoteSettings: {
      allowScriptWrite: await allowAuthorNoteScriptWrite(db),
    },
  };
}
async function insert(db: AuthorNoteSql, row: AuthorNoteRow) {
  const content = db.dialect === "oracle" ? "COALESCE(?, EMPTY_CLOB())" : "?";
  await db.execute(
    `INSERT INTO ${authorNoteTables(db).notes} (id, name, content, content_hash, updated_at) VALUES (?, ${content}, ${content}, ?, ?)`,
    [row.id, row.name, row.content, row.contentHash, row.updatedAt],
  );
}
export async function resetAuthorNotes(db: AuthorNoteSql): Promise<void> {
  const tables = authorNoteTables(db);
  await db.execute(`DELETE FROM ${tables.notes}`);
  await db.execute(`DELETE FROM ${tables.settings}`);
  await insert(db, {
    id: NO_AUTHOR_NOTE,
    name: "",
    content: "",
    contentHash: EMPTY_AUTHOR_NOTE_HASH,
    updatedAt: 0,
  });
  await db.execute(
    `INSERT INTO ${tables.settings} (singleton, allow_script_write, updated_at) VALUES (1, ?, 0)`,
    [db.dialect === "postgres" ? false : 0],
  );
}
/** Called under the backend's revision lock; native SQLite queues the returned SQL in the same guarded transaction. */
export async function applyAuthorNotes(
  db: AuthorNoteSql,
  raw?: AuthorNoteOperation[],
): Promise<AuthorNoteRow[]> {
  const operations = parseAuthorNoteOperations(raw) ?? [];
  const saved: AuthorNoteRow[] = [];
  const tables = authorNoteTables(db);
  const staged = new Map<
    string,
    (AuthorNoteMetadata & { contentHash: string }) | null
  >();
  let cleared = false;
  let stagedScriptWrite: boolean | undefined;
  for (const op of operations) {
    if (op.type === "restore") {
      if (op.clear !== false) {
        await resetAuthorNotes(db);
        staged.clear();
        cleared = true;
        stagedScriptWrite = op.allowScriptWrite;
      }
      for (const row of op.rows) {
        if (row.id === NO_AUTHOR_NOTE) continue;
        const contentHash = await hashAuthorNote(row.content);
        await insert(db, { ...row, contentHash });
        staged.set(row.id, {
          id: row.id,
          name: row.name,
          updatedAt: row.updatedAt,
          contentHash,
        });
      }
      if (op.clear !== false)
        await db.execute(
          `UPDATE ${tables.settings} SET allow_script_write = ?, updated_at = ? WHERE singleton = 1`,
          [
            db.dialect === "postgres"
              ? op.allowScriptWrite
              : Number(op.allowScriptWrite),
            Date.now(),
          ],
        );
      continue;
    }
    if (op.type === "settings") {
      stagedScriptWrite = op.allowScriptWrite;
      await db.execute(
        `UPDATE ${tables.settings} SET allow_script_write = ?, updated_at = ? WHERE singleton = 1`,
        [
          db.dialect === "postgres"
            ? op.allowScriptWrite
            : Number(op.allowScriptWrite),
          Date.now(),
        ],
      );
      continue;
    }
    const now = Date.now();
    if (op.type === "create") {
      const row = {
        id: op.id,
        name: op.name,
        content: op.content,
        contentHash: await hashAuthorNote(op.content),
        updatedAt: now,
      };
      await insert(db, row);
      saved.push(row);
      staged.set(row.id, {
        id: row.id,
        name: row.name,
        updatedAt: now,
        contentHash: row.contentHash,
      });
      continue;
    }
    const baseline =
      staged.has(op.id) || cleared
        ? undefined
        : (
            await db.query(
              `SELECT id, name, content_hash, updated_at FROM ${tables.notes} WHERE id = ?`,
              [op.id],
            )
          )[0];
    const current = staged.has(op.id)
      ? staged.get(op.id)
      : baseline
        ? { ...metadata(baseline), contentHash: String(baseline.content_hash) }
        : null;
    if (!current) throw new AuthorNoteError("missing", op.id);
    if (op.type === "remove") {
      await db.execute(`DELETE FROM ${tables.notes} WHERE id = ?`, [op.id]);
      staged.set(op.id, null);
    } else if (op.type === "rename") {
      await db.execute(
        `UPDATE ${tables.notes} SET name = ${db.dialect === "oracle" ? "COALESCE(?, EMPTY_CLOB())" : "?"} WHERE id = ?`,
        [op.name, op.id],
      );
      staged.set(op.id, { ...current, name: op.name });
    } else {
      if (
        op.script &&
        !(stagedScriptWrite ?? (await allowAuthorNoteScriptWrite(db)))
      )
        throw new AuthorNoteError("script-blocked", op.id);
      if (op.script && op.force) throw new AuthorNoteError("protected", op.id);
      if (!op.force && op.expectedHash === null)
        throw new AuthorNoteError("unread", op.id);
      if (!op.force && op.expectedHash !== current.contentHash)
        throw new AuthorNoteError("conflict", op.id);
      const hash = await hashAuthorNote(op.content);
      const content =
        db.dialect === "oracle" ? "COALESCE(?, EMPTY_CLOB())" : "?";
      await db.execute(
        `UPDATE ${tables.notes} SET content = ${content}, content_hash = ?, updated_at = ? WHERE id = ?${op.force ? "" : " AND content_hash = ?"}`,
        [op.content, hash, now, op.id, ...(op.force ? [] : [op.expectedHash])],
      );
      saved.push({
        ...current,
        content: op.content,
        contentHash: hash,
        updatedAt: now,
      });
      staged.set(op.id, { ...current, contentHash: hash, updatedAt: now });
    }
  }
  return saved;
}

interface NoteCommit {
  idempotencyKey?: string;
  authorNotes?: AuthorNoteOperation[];
}
interface NoteReceipt {
  revision: number;
  authorNotes?: Pick<AuthorNoteRow, "id" | "contentHash" | "updatedAt">[];
}
function revisionTable(db: AuthorNoteSql) {
  return db.dialect === "postgres"
    ? "system.revisions"
    : db.dialect === "azure"
      ? "[system].[revisions]"
      : "system_revisions";
}
/** Additive upgrade of the existing revision ledger, without another domain table. */
export async function ensureAuthorNoteReceipts(
  db: AuthorNoteSql,
): Promise<void> {
  const table = revisionTable(db);
  if (db.dialect === "sqlite") {
    const columns = await db.query(`PRAGMA table_info(${table})`);
    for (const name of [
      "note_commit_key",
      "note_commit_hash",
      "note_commit_result",
    ]) {
      if (!columns.some((column) => column.name === name))
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
    }
  } else if (db.dialect === "postgres") {
    for (const name of [
      "note_commit_key",
      "note_commit_hash",
      "note_commit_result",
    ])
      await db.execute(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} TEXT`,
      );
  } else if (db.dialect === "azure") {
    for (const name of [
      "note_commit_key",
      "note_commit_hash",
      "note_commit_result",
    ])
      await db.execute(
        `IF COL_LENGTH('system.revisions', '${name}') IS NULL ALTER TABLE ${table} ADD ${name} NVARCHAR(MAX)`,
      );
  } else {
    const columns = await db.query(
      "SELECT column_name FROM user_tab_columns WHERE table_name = 'SYSTEM_REVISIONS'",
    );
    for (const [name, type] of [
      ["note_commit_key", "VARCHAR2(128)"],
      ["note_commit_hash", "VARCHAR2(64)"],
      ["note_commit_result", "CLOB"],
    ]) {
      if (
        !columns.some(
          (column) => String(column.column_name).toLowerCase() === name,
        )
      )
        await db.execute(`ALTER TABLE ${table} ADD (${name} ${type})`);
    }
  }
}
export async function readAuthorNoteReceipt(
  db: AuthorNoteSql,
  commit: NoteCommit,
): Promise<NoteReceipt | null> {
  if (!commit.authorNotes?.length || !commit.idempotencyKey) return null;
  const row = (
    await db.query(
      `SELECT note_commit_hash, note_commit_result FROM ${revisionTable(db)} WHERE note_commit_key = ?`,
      [commit.idempotencyKey],
    )
  )[0];
  if (!row) return null;
  if (
    String(row.note_commit_hash) !==
    (await hashAuthorNote(
      JSON.stringify(parseAuthorNoteOperations(commit.authorNotes)),
    ))
  )
    throw new Error(
      "Author note idempotency key reused with different operations",
    );
  return JSON.parse(String(row.note_commit_result)) as NoteReceipt;
}
export async function writeAuthorNoteReceipt(
  db: AuthorNoteSql,
  commit: NoteCommit,
  result: NoteReceipt,
): Promise<void> {
  if (!commit.authorNotes?.length || !commit.idempotencyKey) return;
  await db.execute(
    `UPDATE ${revisionTable(db)} SET note_commit_key = ?, note_commit_hash = ?, note_commit_result = ? WHERE storage_revision = ? AND scope = 'database'`,
    [
      commit.idempotencyKey,
      await hashAuthorNote(
        JSON.stringify(parseAuthorNoteOperations(commit.authorNotes)),
      ),
      JSON.stringify(result),
      result.revision,
    ],
  );
}
