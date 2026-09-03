import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import { createEmptySqlCommit, SqlRevisionConflictError } from "../sqlCommit";
import {
  flattenRelationalValue,
  rebuildRelationalValue,
} from "./relationalNodeCodec";
import {
  makeWebStorage,
  makeTauriStorage,
  type QueryLog,
} from "./sqliteTestHarness";
import { WebSqliteStorage } from "./web/webSqliteStorage";
import { TauriSqliteStorage } from "./tauri/tauriSqliteStorage";

/**
 * Backend-specific behavioral tests layered on the shared contract suite
 * (sqliteBackends.shared.test.ts). The harnesses live in sqliteTestHarness
 * so the web/tauri backends execute real SQL against node:sqlite.
 */

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

function makeFreshWeb() {
  const database = new DatabaseSync(":memory:");
  database.exec(sqliteSchemaSql);
  const storage = makeWebStorage(database);
  return {
    database,
    storage,
    queryLog: (storage as any).__log as QueryLog,
  };
}

describe("WebSqliteStorage", () => {
  it("normalizes messageLimit before binding LIMIT", async () => {
    const { database, storage } = makeFreshWeb();
    database.exec(`
      INSERT INTO characters (id, position, name) VALUES ('char-1', 0, 'Test');
      INSERT INTO chats (id, character_id, position, name) VALUES ('chat-1', 'char-1', 0, 'Chat');
      INSERT INTO messages (chat_id, id, position, role, content_text) VALUES
        ('chat-1', 'm1', 0, 'user', 'one'),
        ('chat-1', 'm2', 1, 'char', 'two'),
        ('chat-1', 'm3', 2, 'user', 'three');
      INSERT INTO chat_branches
        (chat_id, id, head_message_id, reason, created_at)
        VALUES ('chat-1', 'root-1', 'm3', 'root', 0);
      INSERT INTO chat_active_branches (chat_id, branch_id)
        VALUES ('chat-1', 'root-1');
      INSERT INTO message_branch_links
        (chat_id, message_id, parent_message_id, origin_branch_id) VALUES
        ('chat-1', 'm1', NULL, 'root-1'),
        ('chat-1', 'm2', 'm1', 'root-1'),
        ('chat-1', 'm3', 'm2', 'root-1');
    `);
    const chat = await storage.loadChat("chat-1", { messageLimit: 0 });
    expect(chat?.messageOffset).toBe(2);
    expect(chat?.message).toHaveLength(1);
    database.close();
  });

  it("loads an opened chat with one batched worker read", async () => {
    const { database, storage } = makeFreshWeb();
    database.exec(sqliteSchemaSql);
    database.exec(`
      INSERT INTO characters (id, position, name) VALUES ('char-1', 0, 'Test');
      INSERT INTO chats (id, character_id, position, name) VALUES ('chat-1', 'char-1', 0, 'Chat');
      INSERT INTO messages (chat_id, id, position, role, content_text) VALUES
        ('chat-1', 'm1', 0, 'user', 'one'),
        ('chat-1', 'm2', 1, 'char', 'two'),
        ('chat-1', 'm3', 2, 'user', 'three');
      INSERT INTO chat_branches
        (chat_id, id, head_message_id, reason, created_at)
        VALUES ('chat-1', 'root-1', 'm3', 'root', 0);
      INSERT INTO chat_active_branches (chat_id, branch_id)
        VALUES ('chat-1', 'root-1');
      INSERT INTO message_branch_links
        (chat_id, message_id, parent_message_id, origin_branch_id) VALUES
        ('chat-1', 'm1', NULL, 'root-1'),
        ('chat-1', 'm2', 'm1', 'root-1'),
        ('chat-1', 'm3', 'm2', 'root-1');
    `);
    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "selectBatch");

    const chat = await storage.loadChat("chat-1", { messageLimit: 2 });

    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statements = batchSpy.mock.calls[0][0] as Array<{
      sql: string;
      transform?: "relational" | "messages";
    }>;
    expect(
      statements.find(({ sql }) => sql.includes("chat_extension_nodes"))
        ?.transform,
    ).toBe("relational");
    expect(
      statements.find(({ sql }) => sql.includes("message_extension_nodes"))
        ?.transform,
    ).toBe("messages");
    expect(chat?.message.map((message) => message.chatId)).toEqual([
      "m2",
      "m3",
    ]);
    expect(chat?.messageOffset).toBe(1);
    database.close();
  });

  it("updates character interaction time without rewriting extension nodes", async () => {
    const { database, storage, queryLog } = makeFreshWeb();
    database.exec(
      "INSERT INTO characters (id, position, name) VALUES ('char-touch', 0, 'Touch')",
    );
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
      statements.some(({ sql }) =>
        sql.includes("INSERT INTO system_revisions"),
      ),
    ).toBe(false);
    const revisionRows = database
      .prepare("SELECT COUNT(*) AS count FROM system_revisions")
      .get() as { count: number };
    expect(Number(revisionRows.count)).toBe(0);
    expect(storage.getRevision()).toBe(1);
    database.close();
  });

  it("updates relational trees without rewriting every node", async () => {
    const { database, storage } = makeFreshWeb();
    const initialValue = {
      stable: Array.from({ length: 300 }, (_, index) => index),
      changed: "before",
    };
    const initial = createEmptySqlCommit(0, "seed-tree");
    initial.root.upserts.push({
      key: "writeAmplificationTest",
      value: initialValue,
    });
    await storage.commit(initial);

    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "execBatch");
    const changesBefore = Number(
      (
        database.prepare("SELECT total_changes() AS count").get() as {
          count: number;
        }
      ).count,
    );
    const updatedValue = { ...initialValue, changed: "after" };
    const updated = createEmptySqlCommit(1, "update-tree");
    updated.root.upserts.push({
      key: "writeAmplificationTest",
      value: updatedValue,
    });
    await storage.commit(updated);
    const changesAfter = Number(
      (
        database.prepare("SELECT total_changes() AS count").get() as {
          count: number;
        }
      ).count,
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
    expect(nodeWrites.every(({ sql }) => sql.includes("ON CONFLICT"))).toBe(
      true,
    );
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
    shrunk.root.upserts.push({
      key: "writeAmplificationTest",
      value: shrunkValue,
    });
    await storage.commit(shrunk);
    expect(
      await (storage as any).loadSettingValue("writeAmplificationTest"),
    ).toEqual(shrunkValue);
    const count = database
      .prepare(
        "SELECT COUNT(*) AS count FROM setting_extension_nodes WHERE setting_key = 'writeAmplificationTest'",
      )
      .get() as { count: number };
    expect(Number(count.count)).toBe(
      flattenRelationalValue(shrunkValue).length,
    );
    database.close();
  });

  it("migrates legacy module arrays and updates only the addressed module", async () => {
    const { database, storage } = makeFreshWeb();
    const first = { id: "module-a", name: "A", description: "keep" };
    const second = { id: "module-b", name: "B", description: "keep" };
    const legacy = createEmptySqlCommit(0, "legacy-modules");
    legacy.root.upserts.push({ key: "modules", value: [first, second] });
    await storage.commit(legacy);
    expect(await storage.loadModules()).toEqual([first, second]);

    const created = { id: "module-c", name: "C" };
    const migrate = createEmptySqlCommit(1, "modules");
    migrate.modules = {
      upserts: [{ id: created.id, position: 2, data: created }],
      deletes: [],
      order: [first.id, second.id, created.id],
    };
    await storage.commit(migrate);

    expect(await storage.loadModules()).toEqual([first, second, created]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM module_records").get(),
    ).toEqual({ count: 3 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM system_settings WHERE key = 'modules'",
        )
        .get(),
    ).toEqual({ count: 0 });

    const rpc = (storage as any).rpc;
    const batchSpy = vi.spyOn(rpc, "execBatch");
    const updated = { ...first, name: "A2" };
    const delta = createEmptySqlCommit(2, "modules");
    delta.modules = {
      upserts: [{ id: updated.id, position: 0, data: updated }],
      deletes: [],
    };
    await storage.commit(delta);

    expect(await storage.loadModules()).toEqual([updated, second, created]);
    const statements = batchSpy.mock.calls[0][0] as Array<{
      sql: string;
      bind?: unknown[];
    }>;
    const moduleNodeWrites = statements.filter(({ sql }) =>
      sql.includes("module_extension_nodes"),
    );
    expect(moduleNodeWrites.length).toBeGreaterThan(0);
    expect(moduleNodeWrites.every(({ bind }) => bind?.[0] === updated.id)).toBe(
      true,
    );
    database.close();
  });

  it("preserves unchanged character tags without delete-and-reinsert churn", async () => {
    const { database, storage } = makeFreshWeb();
    const tags = Array.from({ length: 300 }, (_, index) => `tag-${index}`);
    const initial = createEmptySqlCommit(0, "seed-character-tags");
    initial.characters.push({
      id: "char-tags",
      position: 0,
      data: { name: "Before", tags },
    });
    await storage.commit(initial);

    const changesBefore = Number(
      (
        database.prepare("SELECT total_changes() AS count").get() as {
          count: number;
        }
      ).count,
    );
    const updated = createEmptySqlCommit(1, "update-character-tags");
    updated.characters.push({
      id: "char-tags",
      position: 0,
      data: { name: "After", tags },
    });
    await storage.commit(updated);
    const changesAfter = Number(
      (
        database.prepare("SELECT total_changes() AS count").get() as {
          count: number;
        }
      ).count,
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
    const { database, storage } = makeFreshWeb();
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
    const { database, storage } = makeFreshWeb();
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
    const { database, storage } = makeFreshWeb();
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
    const { database, storage } = makeFreshWeb();
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
    const loaded = await storage.loadStartupData();
    expect(
      Object.prototype.hasOwnProperty.call(loaded?.settings ?? {}, "username"),
    ).toBe(false);
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
    expect(
      (await storage.loadBotPreset(summaries[0].id))?.moduleIntergration,
    ).toBe("module-a");
    database.close();
  });
});

describe("TauriSqliteStorage", () => {
  it("sends a commit as one native transaction with real SQL execution", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeTauriStorage(database);
    const invoke = (storage as any).__invoke;

    await expect(storage.commit(createEmptySqlCommit(0))).resolves.toEqual({
      revision: 1,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, payload] = invoke.mock.calls[0];
    expect(command).toBe("sqlite_execute_transaction");
    expect(payload.expectedRevision).toBe(0);
    expect(payload).not.toHaveProperty("dbPath");
    expect(
      payload.statements.some((entry: any) =>
        entry.sql.includes("UPDATE system_storage_meta"),
      ),
    ).toBe(true);
    expect(
      payload.statements.every(
        (entry: any) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(entry.sql.trim()),
      ),
    ).toBe(true);
    // The native transaction actually executed: the revision persisted.
    const row = database
      .prepare(
        "SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1",
      )
      .get() as { revision: number; initialized: number };
    expect(row.revision).toBe(1);
    expect(row.initialized).toBe(1);
    database.close();
  });

  it("maps a native revision conflict back to the storage error", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeTauriStorage(database);
    await storage.commit(createEmptySqlCommit(0));

    const stale = createEmptySqlCommit(0, "stale");
    stale.root.upserts.push({ key: "conflict", value: true });
    await expect(storage.commit(stale)).rejects.toBeInstanceOf(
      SqlRevisionConflictError,
    );
    // The conflicting write must not have persisted.
    const rows = database
      .prepare("SELECT COUNT(*) AS count FROM system_settings")
      .get() as { count: number };
    expect(Number(rows.count)).toBe(0);
    database.close();
  });

  it("normalizes messageLimit before passing it to SQLite", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    database.exec(`
      INSERT INTO characters (id, position, name) VALUES ('char-1', 0, 'Test');
      INSERT INTO chats (id, character_id, position, name) VALUES ('chat-1', 'char-1', 0, 'Chat');
      INSERT INTO messages (chat_id, id, position, role, content_text) VALUES
        ('chat-1', 'm1', 0, 'user', 'one'),
        ('chat-1', 'm2', 1, 'char', 'two'),
        ('chat-1', 'm3', 2, 'user', 'three');
    `);
    const storage = makeTauriStorage(database);
    const queryLog = (storage as any).__log as QueryLog;

    const chat = await storage.loadChat("chat-1", { messageLimit: 0 });
    expect(chat?.messageOffset).toBe(2);
    const limitedCall = queryLog.entries.find(
      ({ sql }) => sql.includes("FROM messages") && sql.includes("LIMIT"),
    );
    expect(limitedCall).toBeDefined();
    // messageLimit 0 normalizes to 1 row.
    expect(chat?.message).toHaveLength(1);
    database.close();
  });
});
