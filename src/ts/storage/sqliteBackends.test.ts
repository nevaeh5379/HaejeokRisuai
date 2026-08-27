import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import {
  createEmptySqlCommit,
  SqlRevisionConflictError,
} from "./sqlCommit";
import { WebSqliteStorage } from "./webSqliteStorage";
import {
  flattenRelationalValue,
  rebuildRelationalValue,
} from "./relationalNodeCodec";

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
    selectBatch: async (
      statements: Array<{
        sql: string;
        bind?: unknown[];
        transform?: "relational" | "messages";
      }>,
    ) =>
      statements.map(({ sql, bind = [], transform }) => {
        const selected = selectRows(sql, bind);
        if (transform === "relational") {
          return {
            value: selected.rows.length
              ? rebuildRelationalValue(selected.rows)
              : undefined,
          };
        }
        if (transform === "messages") {
          const nodeGroups = new Map<string, Record<string, unknown>[]>();
          const coreRows = new Map<string, Record<string, unknown>>();
          const orderedIds: string[] = [];
          for (const row of selected.rows) {
            const id = String(row.message_id);
            if (!coreRows.has(id)) {
              coreRows.set(id, row);
              orderedIds.push(id);
            }
            if (row.node_id === null || row.node_id === undefined) continue;
            const nodes = nodeGroups.get(id) ?? [];
            nodes.push(row);
            nodeGroups.set(id, nodes);
          }
          return {
            value: orderedIds.map((id) => {
              const core = coreRows.get(id)!;
              const nodes = nodeGroups.get(id);
              const message = (nodes?.length
                ? rebuildRelationalValue(nodes)
                : {
                    role: String(core.message_role ?? "char"),
                    data: String(core.message_content_text ?? ""),
                  }) as Record<string, unknown>;
              message.chatId = id;
              return message;
            }),
          };
        }
        return selected;
      }),
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

  it("loads interactive character summaries without hydrating every chat detail", async () => {
    const database = new DatabaseSync(":memory:");
    seedChat(database);
    database.exec(
      "INSERT INTO chats (id, character_id, position, name) VALUES ('chat-2', 'char-1', 1, 'Second')",
    );
    const storage = makeWebStorage(database);
    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "selectBatch");

    const character = await storage.loadCharacterForSelection("char-1");

    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statements = batchSpy.mock.calls[0][0] as Array<{
      sql: string;
      transform?: "relational";
    }>;
    expect(statements.some(({ sql }) => sql.includes("chat_extension_nodes"))).toBe(
      false,
    );
    expect(
      statements.find(({ sql }) => sql.includes("character_extension_nodes"))
        ?.transform,
    ).toBe("relational");
    expect(character?.chats.map((chat) => chat.id)).toEqual([
      "chat-1",
      "chat-2",
    ]);
    expect(character?.chats.every((chat) => chat.detailsLoaded === false)).toBe(
      true,
    );
    database.close();
  });

  it("loads an opened chat with one batched worker read", async () => {
    const database = new DatabaseSync(":memory:");
    seedChat(database);
    const storage = makeWebStorage(database);
    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "selectBatch");

    const chat = await storage.loadChat("chat-1", { messageLimit: 2 });

    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statements = batchSpy.mock.calls[0][0] as Array<{
      sql: string;
      transform?: "relational" | "messages";
    }>;
    expect(
      statements.find(({ sql }) => sql.includes("chat_extension_nodes"))?.transform,
    ).toBe("relational");
    expect(
      statements.find(({ sql }) => sql.includes("message_extension_nodes"))
        ?.transform,
    ).toBe("messages");
    expect(chat?.message.map((message) => message.chatId)).toEqual(["m2", "m3"]);
    expect(chat?.messageOffset).toBe(1);
    database.close();
  });

  it("updates character interaction time without rewriting extension nodes", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    database.exec(
      "INSERT INTO characters (id, position, name) VALUES ('char-touch', 0, 'Touch')",
    );
    const storage = makeWebStorage(database);
    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "execBatch");
    const commit = createEmptySqlCommit(0, "character-touch");
    commit.characterTouches = [
      { id: "char-touch", lastInteraction: 123456789 },
    ];

    await storage.commit(commit);

    const row = database
      .prepare(
        "SELECT last_interaction_time FROM characters WHERE id = 'char-touch'",
      )
      .get() as { last_interaction_time: number };
    expect(row.last_interaction_time).toBe(123456789);
    const statements = batchSpy.mock.calls[0][0] as Array<{ sql: string }>;
    expect(
      statements.some(({ sql }) => sql.includes("last_interaction_time")),
    ).toBe(true);
    expect(
      statements.some(({ sql }) => sql.includes("character_extension_nodes")),
    ).toBe(false);
    expect(
      statements.some(({ sql }) => sql.includes("INSERT INTO system_revisions")),
    ).toBe(false);
    const revisionRows = database
      .prepare("SELECT COUNT(*) AS count FROM system_revisions")
      .get() as { count: number };
    expect(Number(revisionRows.count)).toBe(0);
    expect(storage.getRevision()).toBe(1);
    database.close();
  });

  it("updates relational trees without rewriting every node", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeWebStorage(database);
    const initialValue = {
      stable: Array.from({ length: 300 }, (_, index) => index),
      changed: "before",
    };
    const initial = createEmptySqlCommit(0, "seed-tree");
    initial.root.upserts.push({ key: "writeAmplificationTest", value: initialValue });
    await storage.commit(initial);

    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "execBatch");
    const changesBefore = Number(
      (database.prepare("SELECT total_changes() AS count").get() as { count: number })
        .count,
    );
    const updatedValue = { ...initialValue, changed: "after" };
    const updated = createEmptySqlCommit(1, "update-tree");
    updated.root.upserts.push({ key: "writeAmplificationTest", value: updatedValue });
    await storage.commit(updated);
    const changesAfter = Number(
      (database.prepare("SELECT total_changes() AS count").get() as { count: number })
        .count,
    );
    expect(changesAfter - changesBefore).toBeLessThan(10);

    const statements = batchSpy.mock.calls[0][0] as Array<{
      sql: string;
      bind?: unknown[];
    }>;
    const nodeWrites = statements.filter(({ sql }) =>
      sql.includes("INSERT INTO setting_extension_nodes"),
    );
    expect(nodeWrites.length).toBeLessThan(10);
    expect(nodeWrites.every(({ sql }) => sql.includes("ON CONFLICT"))).toBe(true);
    expect(
      statements.some(
        ({ sql }) =>
          sql.trim() ===
          "DELETE FROM setting_extension_nodes WHERE setting_key = ?",
      ),
    ).toBe(false);
    expect(
      await (storage as any).loadSettingValue("writeAmplificationTest"),
    ).toEqual(updatedValue);

    const shrunkValue = { changed: "small" };
    const shrunk = createEmptySqlCommit(2, "shrink-tree");
    shrunk.root.upserts.push({ key: "writeAmplificationTest", value: shrunkValue });
    await storage.commit(shrunk);
    expect(
      await (storage as any).loadSettingValue("writeAmplificationTest"),
    ).toEqual(shrunkValue);
    const count = database
      .prepare(
        "SELECT COUNT(*) AS count FROM setting_extension_nodes WHERE setting_key = 'writeAmplificationTest'",
      )
      .get() as { count: number };
    expect(Number(count.count)).toBe(flattenRelationalValue(shrunkValue).length);
    database.close();
  });

  it("preserves unchanged character tags without delete-and-reinsert churn", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeWebStorage(database);
    const tags = Array.from({ length: 300 }, (_, index) => `tag-${index}`);
    const initial = createEmptySqlCommit(0, "seed-character-tags");
    initial.characters.push({
      id: "char-tags",
      position: 0,
      data: { name: "Before", tags },
    });
    await storage.commit(initial);

    const changesBefore = Number(
      (database.prepare("SELECT total_changes() AS count").get() as { count: number })
        .count,
    );
    const updated = createEmptySqlCommit(1, "update-character-tags");
    updated.characters.push({
      id: "char-tags",
      position: 0,
      data: { name: "After", tags },
    });
    await storage.commit(updated);
    const changesAfter = Number(
      (database.prepare("SELECT total_changes() AS count").get() as { count: number })
        .count,
    );

    expect(changesAfter - changesBefore).toBeLessThan(10);
    const storedTags = database
      .prepare(
        "SELECT position, tag FROM character_tags WHERE character_id = ? ORDER BY position",
      )
      .all("char-tags") as { position: number; tag: string }[];
    expect(storedTags).toHaveLength(tags.length);
    expect(storedTags.map(({ tag }) => tag)).toEqual(tags);
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

  it("rolls back every row and the revision when a batch fails midway", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeWebStorage(database);
    const seed = createEmptySqlCommit(0, "seed");
    seed.root.upserts.push({ key: "durable", value: { version: 1 } });
    await storage.commit(seed);

    const rpc = (storage as any).rpc;
    vi.spyOn(rpc, "execBatch").mockImplementationOnce(
      async (statements: Array<{ sql: string; bind?: unknown[] }>) => {
        const first = statements.find(({ sql }) =>
          sql.includes("system_settings"),
        )!;
        database.prepare(first.sql).run(...((first.bind ?? []) as any[]));
        throw new Error("simulated disk failure");
      },
    );
    const failed = createEmptySqlCommit(1, "failed-update");
    failed.root.upserts.push(
      { key: "durable", value: { version: 2 } },
      { key: "new-key", value: "must-not-appear" },
    );

    await expect(storage.commit(failed)).rejects.toThrow(
      "simulated disk failure",
    );
    expect(storage.getRevision()).toBe(1);
    expect(await (storage as any).loadSettingValue("durable")).toEqual({
      version: 1,
    });
    expect(await (storage as any).loadSettingValue("new-key")).toBeUndefined();
    database.close();
  });

  it("round-trips migration data across lazy domains and message hydration", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeWebStorage(database);
    const source = {
      username: "Migration User",
      moduleIntergration: "module-a",
      pluginCustomStorage: { plugin: { nested: [1, null, "three"] } },
      personas: [{ id: "persona-a", name: "Persona A", prompt: "remember" }],
      modules: [{ id: "module-a", name: "Module A", lorebook: [] }],
      loreBook: [{ name: "World", data: [{ key: "fact", content: "value" }] }],
      botPresetsId: 0,
      botPresets: [{ name: "Preset A", apiType: "openai", aiModel: "gpt" }],
      characters: [
        {
          chaId: "char-roundtrip",
          type: "character",
          name: "Roundtrip",
          chats: [
            {
              id: "chat-roundtrip",
              name: "History",
              message: [
                { chatId: "msg-1", role: "user", data: "one" },
                {
                  chatId: "msg-2",
                  role: "char",
                  data: "two",
                  custom: { empty: {}, list: [false, 0, ""] },
                },
              ],
            },
          ],
        },
      ],
    } as any;

    await expect(storage.replaceDatabase(source)).resolves.toBe(true);
    const loaded = await storage.loadDatabase({ shallow: true });
    expect(loaded?.database?.username).toBe("Migration User");
    expect(await storage.loadPluginCustomStorageKey("plugin")).toEqual({
      nested: [1, null, "three"],
    });
    expect(await storage.loadPersonas()).toEqual(source.personas);
    expect(await storage.loadModules()).toEqual(source.modules);
    expect(await storage.loadLorebooks()).toEqual(source.loreBook);
    const character = await storage.loadCharacter("char-roundtrip");
    expect(character?.name).toBe("Roundtrip");
    expect(character?.chats[0].messagesLoaded).toBe(false);
    const chat = await storage.loadChat("chat-roundtrip");
    expect(chat?.message).toEqual(source.characters[0].chats[0].message);
    const summaries = await storage.listBotPresets();
    expect(summaries).toHaveLength(1);
    expect((await storage.loadBotPreset(summaries[0].id))?.moduleIntergration).toBe(
      "module-a",
    );
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
