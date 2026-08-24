import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import {
  createEmptySqlCommit,
  SqlRevisionConflictError,
} from "./sqlCommit";
import { WebSqliteStorage } from "./webSqliteStorage";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { TauriSqliteStorage } from "./tauriSqliteStorage";

class WebStatementAdapter {
  private params: unknown[] = [];
  private iterator: Iterator<Record<string, unknown>> | null = null;
  private current: Record<string, unknown> | null = null;
  private executed = false;
  readonly columnNames: string[];

  constructor(private readonly statement: StatementSync) {
    this.columnNames = statement.columns().map((column) => column.name);
  }

  bind(params: unknown[]) {
    this.params = params;
  }
  step(): boolean {
    if (this.columnNames.length === 0) {
      if (!this.executed) {
        this.statement.run(...(this.params as any[]));
        this.executed = true;
      }
      return false;
    }
    this.iterator ??= this.statement
      .iterate(...(this.params as any[]))[Symbol.iterator]();
    const next = this.iterator.next();
    if (next.done) return false;
    this.current = next.value as Record<string, unknown>;
    return true;
  }

  get(): unknown[] {
    return this.columnNames.map((name) => this.current?.[name]);
  }

  finalize() {}
}

class WebDatabaseAdapter {
  constructor(readonly database: DatabaseSync) {}
  exec(sql: string) {
    this.database.exec(sql);
  }
  prepare(sql: string) {
    return new WebStatementAdapter(this.database.prepare(sql));
  }
  close() {
    this.database.close();
  }
}

function seedChat(database: DatabaseSync) {
  database.exec(sqliteSchemaSql);
  database.exec(`
    INSERT INTO characters (id, position, name) VALUES ('char-1', 0, 'Test');
    INSERT INTO chats (id, character_id, position, name) VALUES ('chat-1', 'char-1', 0, 'Chat');
    INSERT INTO messages (chat_id, id, position, role, content_text) VALUES
      ('chat-1', 'm1', 0, 'user', 'one'),
      ('chat-1', 'm2', 1, 'char', 'two'),
      ('chat-1', 'm3', 2, 'user', 'three');
  `);
}

/** In-process mock of the Worker RPC protocol used by WebSqliteStorage. */
function makeWebStorage(database: DatabaseSync) {
  const storage = new WebSqliteStorage();
  const db = new WebDatabaseAdapter(database);

  const selectRows = (sql: string, bind: unknown[] = []) => {
    const stmt = db.prepare(sql);
    try {
      if (bind.length > 0) stmt.bind(bind);
      const results: Record<string, unknown>[] = [];
      const cols = stmt.columnNames;
      while (stmt.step()) {
        const row = stmt.get() as unknown[];
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
        results.push(obj);
      }
      return { rows: results, columns: cols };
    } finally {
      stmt.finalize();
    }
  };

  const rpc = {
    init: async () => ({ enabled: true, revision: 0 }),
    exec: async (sql: string, bind: unknown[] = []) => {
      if (bind.length === 0) db.exec(sql);
      else {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(bind);
          stmt.step();
        } finally {
          stmt.finalize();
        }
      }
    },
    execBatch: async (
      statements: Array<{ sql: string; bind?: unknown[] }>,
    ) => {
      for (const { sql, bind = [] } of statements) {
        if (bind.length === 0) db.exec(sql);
        else {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(bind);
            stmt.step();
          } finally {
            stmt.finalize();
          }
        }
      }
    },
    select: async (sql: string, bind: unknown[] = []) => selectRows(sql, bind),
    selectOne: async (sql: string, bind: unknown[] = []) =>
      selectRows(sql, bind).rows[0] ?? null,
    close: async () => {
      db.close();
    },
    terminate: () => {},
  };

  (storage as any).rpc = rpc;
  (storage as any)._enabled = true;
  (storage as any).initialized = true;
  return storage;
}

describe("WebSqliteStorage", () => {
  it("normalizes messageLimit before binding LIMIT", async () => {
    const database = new DatabaseSync(":memory:");
    seedChat(database);
    const storage = makeWebStorage(database);
    const chat = await storage.loadChat("chat-1", { messageLimit: 0 });
    expect(chat?.messageOffset).toBe(2);
    expect(chat?.message).toHaveLength(1);
    database.close();
  });

  it("restores stable message ids across full and paged loads", async () => {
    const database = new DatabaseSync(":memory:");
    seedChat(database);
    const storage = makeWebStorage(database);

    const chat = await storage.loadChat("chat-1");
    expect(chat?.message.map((message) => message.chatId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(chat?.message.map((message) => message.data)).toEqual([
      "one",
      "two",
      "three",
    ]);

    const all = await storage.loadChatMessages("chat-1");
    expect(all.map((message) => message.chatId)).toEqual(["m1", "m2", "m3"]);

    const page = await storage.loadChatMessagePage("chat-1", undefined, 2);
    expect(page.messages.map((message) => message.chatId)).toEqual(["m2", "m3"]);
    database.close();
  });

  it("batches commit statements into a single worker RPC", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeWebStorage(database);
    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "execBatch");

    await storage.commit(createEmptySqlCommit(0, "batched"));

    expect(batchSpy).toHaveBeenCalledTimes(1);
    const batchedStatements = batchSpy.mock.calls[0][0] as Array<{
      sql: string;
      bind?: unknown[];
    }>;
    expect(batchedStatements.length).toBeGreaterThan(1);
    database.close();
  });

  it("serializes concurrent commits into a revision conflict", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeWebStorage(database);
    const first = createEmptySqlCommit(0, "first");
    const second = createEmptySqlCommit(0, "second");
    const [firstResult, secondResult] = await Promise.allSettled([
      storage.commit(first),
      storage.commit(second),
    ]);
    expect(firstResult).toMatchObject({
      status: "fulfilled",
      value: { revision: 1 },
    });
    expect(secondResult.status).toBe("rejected");
    if (secondResult.status === "rejected") {
      expect(secondResult.reason).toBeInstanceOf(SqlRevisionConflictError);
      expect(secondResult.reason.currentRevision).toBe(1);
    }
    database.close();
  });
});

describe("TauriSqliteStorage", () => {
  it("sends a commit as one native transaction", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    const select = vi.fn().mockResolvedValue([{ revision: 0 }]);
    const storage = new TauriSqliteStorage();
    (storage as any).db = { select, path: "sqlite:test.db" };
    (storage as any).dbPath = "/tmp/test.db";
    (storage as any)._enabled = true;

    await expect(storage.commit(createEmptySqlCommit(0))).resolves.toEqual({
      revision: 1,
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0];
    expect(command).toBe("sqlite_execute_transaction");
    expect(payload.expectedRevision).toBe(0);
    expect(payload).not.toHaveProperty("dbPath");
    expect(payload.statements.some((entry: any) =>
      entry.sql.includes("UPDATE system_storage_meta"),
    )).toBe(true);
    expect(payload.statements.every((entry: any) =>
      !/^(BEGIN|COMMIT|ROLLBACK)/i.test(entry.sql.trim()),
    )).toBe(true);
  });

  it("maps a native revision conflict back to the storage error", async () => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue("RISU_SQL_REVISION_CONFLICT:5");
    const storage = new TauriSqliteStorage();
    (storage as any).db = {
      select: vi.fn().mockResolvedValue([{ revision: 0 }]),
      path: "sqlite:test.db",
    };
    (storage as any).dbPath = "/tmp/test.db";
    (storage as any)._enabled = true;
    const result = storage.commit(createEmptySqlCommit(0));
    await expect(result).rejects.toBeInstanceOf(SqlRevisionConflictError);
    await result.catch((error) => {
      expect(error.currentRevision).toBe(5);
    });
  });

  it("normalizes messageLimit before passing it to SQLite", async () => {
    const select = vi.fn(async (sql: string, _bind: unknown[] = []) => {
      if (sql.includes("FROM chats WHERE id")) {
        return [{ id: "chat-1", name: "Chat", note: "", folder_id: null, last_message_time: null }];
      }
      if (sql.includes("COUNT(*)")) return [{ total: 3 }];
      if (sql.includes("FROM messages") && sql.includes("LIMIT")) return [{ id: "m3" }];
      return [];
    });
    const storage = new TauriSqliteStorage();
    (storage as any).db = { select, path: "sqlite:test.db" };
    (storage as any)._enabled = true;
    const chat = await storage.loadChat("chat-1", { messageLimit: 0 });
    expect(chat?.messageOffset).toBe(2);
    const limitedCall = select.mock.calls.find(([sql]) =>
      String(sql).includes("FROM messages") && String(sql).includes("LIMIT"),
    );
    expect(limitedCall?.[1]).toEqual(["chat-1", 1, 2]);
  });
});
