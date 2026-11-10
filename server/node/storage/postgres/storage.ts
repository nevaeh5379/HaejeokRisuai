import { encodeJsonValue } from "./jsonCodec.ts";
import {
  Character,
  validateCharacterKeys,
  validateCharacterUpdate,
  type CharacterFields,
  type CharacterUpdate,
} from "../../../../packages/protocol/domain/character.ts";
import {
  CHARACTER_FIELD_COLUMNS,
  CHARACTER_RELATIONS,
  CHAT_FIELD_STORAGE,
  decodeCharacterReadRow,
  type CharacterReadRow,
  type ChatRelationKey,
} from "./relationalCodec.ts";
import type {
  ISqlStorage,
  SqlBackendKind,
  State,
  SqlDatabaseSnapshotResult,
  SqlStorageSyncSummary,
  SqlMessagePage,
  SqlChatBranchSummary,
  SqlChatBranchGraphData,
  SqlChatBranchGraphPage,
  SqlCreateChatBranchInput,
  SqlCharacterListItem,
  RecentChat,
  IPluginStorage,
  PluginLoadOptions,
} from "../../../../packages/storage-core/src/sqlStorage.ts";
import type { Database } from "../../../../packages/protocol/domain/legacy/database.ts";
import type {
  Message,
  customscript,
} from "../../../../packages/protocol/domain/database.ts";
import {
  Chat,
  type ChatFields,
  type ChatUpdate,
} from "../../../../packages/protocol/domain/chat.ts";
import type {
  AuthorNote,
  AuthorNoteFields,
  AuthorNoteUpdate,
} from "../../../../packages/protocol/domain/authorNote.ts";
import type {
  Persona,
  PersonaFields,
  PersonaUpdate,
} from "../../../../packages/protocol/domain/persona.ts";
import type {
  Preset,
  PresetFields,
  PresetUpdate,
} from "../../../../packages/protocol/domain/preset.ts";
import type {
  LorebookFields,
  LorebookUpdate,
} from "../../../../packages/protocol/domain/lorebook.ts";
import type {
  Module,
  ModuleFields,
  ModuleUpdate,
} from "../../../../packages/protocol/domain/module.ts";
import type {
  PromptFields,
  PromptUpdate,
} from "../../../../packages/protocol/domain/prompt.ts";
import type {
  PluginMetadata,
  PluginScript,
  PluginStorageValue,
} from "../../../../packages/protocol/domain/pluginTypes.ts";
import type { SqlCommit } from "../../../../packages/protocol/domain/sqlCommit.ts";
import type { SqlCommitResult } from "../../../../packages/protocol/src/sqlCommit.ts";
import type {
  NodePostgresTableInfo,
  NodePostgresTableData,
  NodePostgresTokenUsage,
  NodePostgresBotChatStats,
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresRestorePreview,
  NodePostgresMessageSearchResult,
  NodePostgresCharacterSearchResult,
} from "../../../../packages/protocol/databaseApi.ts";
import {
  Kysely,
  PostgresDialect as KyselyPostgresDialect,
  sql,
  Transaction,
  type ExpressionBuilder,
  type PostgresPool,
  type Selectable,
} from "kysely";
import { Pool } from "pg";
import { characterPatch } from "./patch/character/index.ts";
import { chatPatch } from "./patch/chat/index.ts";
import { CHAT_RELATIONS } from "./patch/chat/relation.ts";
import { Bookmarks } from "./patch/chat/bookmarks.ts";

/**
 * Module object passed to `saveModule`. The module body is app-defined JSON, so
 * the record stays open beyond the two columns the writer reads.
 */

const BULK_INSERT_BATCH_ROWS = Math.max(
  1,
  Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || "1000", 10) || 1000,
);

import type { CharacterTables } from "../../../../packages/protocol/tables/character.ts";
import type { SystemTables } from "../../../../packages/protocol/tables/system.ts";
import type {
  AttributesTable,
  ChatTables,
  LoreEntriesTable,
} from "../../../../packages/protocol/tables/chat.ts";
import type { ColdTables } from "../../../../packages/protocol/tables/cold.ts";
import { randomUUID } from "node:crypto";
import type { PostgresDatabase } from "./type.ts";
import * as chat from "./utils/chat.ts";
import { beginRevision, lockStorageRevision } from "./utils/revision.ts";

/** Cold-storage value shape produced by the shared splitter. */

export type PostgresStorageContract = PostgresStorage;

/** Minimal injectable pool for character statement execution. */
type PoolLike = {
  connect(): Promise<{
    query(
      text: string,
      parameters: readonly unknown[],
    ): Promise<{
      rows: Record<string, unknown>[];
      rowCount?: number | null;
      command?: string;
    }>;
    release(): void;
  }>;
  end(): Promise<void>;
  options?: object;
};
export class PostgresStorage implements ISqlStorage {
  db: Kysely<PostgresDatabase>;

  readonly backendKind: SqlBackendKind = "node";

  constructor(
    connectionString: string,
    poolMax = 10,
    options?: {
      pool?: PoolLike;
    },
  ) {
    this.db = this.createDatabase(connectionString, poolMax, options?.pool);
  }

  private createDatabase(
    connectionString: string,
    poolMax: number,
    injected?: PoolLike,
  ) {
    const pool = injected ?? new Pool({ max: poolMax, connectionString });
    return new Kysely<PostgresDatabase>({
      dialect: new KyselyPostgresDialect({
        pool: {
          connect: () => pool.connect(),
          end: () => pool.end(),
          options: pool.options ?? {},
        } as PostgresPool,
      }),
    });
  }

  /**
   * Release backend resources before a page reload or application shutdown
   * TODO: Ensure clean pool teardown and connection drain
   * Example usage:
   * await storage.close();
   */
  async close(): Promise<void> {
    await this.db.destroy();
  }

  /**
   * Check if storage backend is enabled
   * TODO: Implement storage availability check for PostgreSQL
   * Example usage:
   * const enabled = storage.isEnabled();
   */
  isEnabled(): boolean {
    throw new Error("Method not implemented.");
  }

  /**
   * Get current storage revision
   * TODO: Query or return cached storage revision
   * Example usage:
   * const revision = storage.getRevision();
   */
  getRevision(): number {
    throw new Error("Method not implemented.");
  }

  /**
   * Reads authoritative metadata for initial loading and cross-query consistency checks
   * TODO: Implement state retrieval from PostgreSQL system table
   * Example usage:
   * const state = await storage.getState();
   */
  async getState(): Promise<State> {
    throw new Error("Method not implemented.");
  }

  /**
   * Initialise the backend (open DB, apply schema, connect to remote)
   * TODO: Run schema migrations and connection health checks
   * Example usage:
   * const ready = await storage.init();
   */
  async init(): Promise<boolean> {
    throw new Error("Method not implemented.");
  }

  /**
   * Get summary of synchronized storage records and revision
   * TODO: Implement storage record counting and revision query
   * Example usage:
   * const summary = await storage.getStorageSyncSummary();
   */
  async getStorageSyncSummary(): Promise<SqlStorageSyncSummary | null> {
    throw new Error("Method not implemented.");
  }

  /**
   * Export aggregate database snapshot
   * TODO: Implement full database snapshot export
   * Example usage:
   * const snapshot = await storage.exportSnapshot();
   */
  async exportSnapshot(): Promise<SqlDatabaseSnapshotResult | null> {
    throw new Error("Method not implemented.");
  }

  /**
   * Commit atomic storage mutations
   * TODO: Execute revision-guarded transactional commit
   * Example usage:
   * const result = await storage.commit(commit);
   */
  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    throw new Error("Method not implemented.");
  }

  /**
   * Replace database contents entirely from a snapshot
   * TODO: Implement database replacement transaction
   * Example usage:
   * await storage.replace(db, (status, progress) => {});
   */
  async replace(
    database: Database,
    onProgress?: (status: string, progress?: number) => void,
  ): Promise<boolean> {
    throw new Error("Method not implemented.");
  }

  /** Database explorer table metadata and rows */
  table = {
    /**
     * List all database tables and column schemas
     * TODO: Implement table schema inspection
     * Example usage:
     * const tables = await storage.table.list();
     */
    list: async (): Promise<NodePostgresTableInfo[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Fetch paged table data with sorting and filtering
     * TODO: Implement dynamic table query
     * Example usage:
     * const data = await storage.table.data("character.characters", { limit: 50 });
     */
    data: async (
      table: string,
      options?: {
        offset?: number;
        limit?: number;
        sortColumn?: string;
        sortOrder?: "asc" | "desc";
        search?: string;
        columns?: string[];
      },
    ): Promise<NodePostgresTableData> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Usage statistics and metrics */
  stats = {
    /**
     * Aggregated token usage by model
     * TODO: Implement token usage aggregation query
     * Example usage:
     * const usage = await storage.stats.tokenUsage();
     */
    tokenUsage: async (): Promise<NodePostgresTokenUsage[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Chat statistics per bot
     * TODO: Implement bot chat metrics query
     * Example usage:
     * const botStats = await storage.stats.botChats();
     */
    botChats: async (): Promise<NodePostgresBotChatStats[]> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Revision history and point-in-time restore */
  revision = {
    /**
     * List recent storage revisions
     * TODO: Query revision log table ordered by ID descending
     * Example usage:
     * const revs = await storage.revision.list(20);
     */
    list: async (limit?: number): Promise<NodePostgresRevision[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Get revision details and changed entities
     * TODO: Fetch revision metadata and change log
     * Example usage:
     * const details = await storage.revision.details(42);
     */
    details: async (
      revisionId: number,
    ): Promise<NodePostgresRevisionDetails | null> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Compute diff between two revisions
     * TODO: Implement revision comparison query
     * Example usage:
     * const diff = await storage.revision.diff(10, 15);
     */
    diff: async (
      baseId: number,
      targetId: number,
    ): Promise<NodePostgresRevisionDiff | null> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Preview changes before restoring revision
     * TODO: Implement restore preview generator
     * Example usage:
     * const preview = await storage.revision.previewRestore(10);
     */
    previewRestore: async (
      revisionId: number,
    ): Promise<NodePostgresRestorePreview | null> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Restore storage state to a specific revision
     * TODO: Implement revision rollback transaction
     * Example usage:
     * const res = await storage.revision.restore(10);
     */
    restore: async (
      revisionId: number,
    ): Promise<{ revision: number; revisionId: number }> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Chat sessions and metadata */
  chat = {
    /**
     * Creates a handle without querying or checking existence
     * TODO: Implement Chat reference handle instantiation
     * Example usage:
     * const handle = storage.chat.ref("chat-id");
     */
    ref: (id: string): Chat => {
      return new Chat(
        id,
        (...keys) => this.chat.read(id, ...keys),
        (patch) => this.chat.update(id, patch),
      );
    },

    /**
     * Checks existence and returns a handle; rejects for a missing chat
     * TODO: Check existence and return Chat handle
     * Example usage:
     * const chat = await storage.chat.load("chat-id");
     */
    load: async (id: string): Promise<Chat> => {
      return this.chat.ref(id);
    },

    /**
     * Reads only requested fields; does not hydrate messages or unrelated large fields
     * TODO: Implement projection query for chat columns
     * Example usage:
     * const fields = await storage.chat.read("chat-id", "name", "position");
     */
    read: async <K extends keyof ChatFields>(
      id: string,
      ...keys: [K, ...K[]]
    ): Promise<Pick<ChatFields, K>> => {
      const plan = chat.planChatRead(keys);

      const row = await this.db
        .selectFrom("chat.chats")
        .select(plan.columns)
        .where("chat.chats.id", "=", id)
        .executeTakeFirst();

      if (row === undefined) {
        throw new Error(`Chat not found: ${id}`);
      }

      const attributes = await this.readChatAttributes(id, keys);
      const related = await this.readChatRelations(id, plan.relationKeys);
      const activeBranch = plan.needsActiveBranch
        ? await this.readChatActiveBranch(id)
        : undefined;

      const rebuilt = chat.rebuild(row, {
        ...related,
        attributes,
      });
      if (activeBranch !== undefined) {
        rebuilt.activeBranchId = activeBranch.branch_id;
      }

      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const value = rebuilt[key];
        if (value !== undefined && value !== null) {
          result[key] = structuredClone(value);
          continue;
        }
        const storage = CHAT_FIELD_STORAGE[key];
        result[key] =
          "fallback" in storage && storage.fallback
            ? storage.fallback()
            : undefined;
      }
      return result as Pick<ChatFields, K>;
    },

    /**
     * Atomic patch: omitted fields survive; supplied collections replace only that field
     * Example usage:
     * await storage.chat.update("chat-id", { name: "New Name" });
     */
    update: async (id: string, patch: ChatUpdate): Promise<void> => {
      if (!Object.values(patch).some((value) => value !== undefined)) return;

      const encoded = chatPatch(id, patch);
      await this.db.transaction().execute(async (trx) => {
        await lockStorageRevision(trx);
        const current = await trx
          .selectFrom("chat.chats")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (!current) throw new Error(`Chat not found: ${id}`);

        await beginRevision(trx, "chat:update");
        await trx
          .updateTable("chat.chats")
          .set({ ...encoded.columns, updated_at: sql`now()` })
          .where("id", "=", id)
          .execute();

        for (const key of Object.keys(
          encoded.relations,
        ) as (keyof typeof encoded.relations)[]) {
          const relation = CHAT_RELATIONS[key];
          const rows = encoded.relations[key];
          if ("memoryType" in relation && rows?.length) {
            const memoryRows =
              encoded.relations[key as "hypaV2Data" | "hypaV3Data"];
            await trx
              .insertInto("chat.memory")
              .values(memoryRows)
              .onConflict((oc) =>
                oc
                  .columns(["chat_id", "memory_type"])
                  .doUpdateSet((eb) => ({
                    payload: eb.ref("excluded.payload"),
                  })),
              )
              .execute();
            continue;
          }
          let deletion = trx
            .deleteFrom(relation.table)
            .where("chat_id", "=", id);
          if ("memoryType" in relation) {
            deletion = deletion.where(
              sql.ref("memory_type"),
              "=",
              relation.memoryType,
            );
          }
          await deletion.execute();
          if (!rows?.length) continue;
          for (
            let start = 0;
            start < rows.length;
            start += BULK_INSERT_BATCH_ROWS
          ) {
            await trx
              .insertInto(relation.table)
              .values(rows.slice(start, start + BULK_INSERT_BATCH_ROWS))
              .execute();
          }
        }
        if (
          patch.bookmarks !== undefined ||
          patch.bookmarkNames !== undefined
        ) {
          const currentBookmarks = await trx
            .selectFrom("chat.bookmarks")
            .select(["message_id", "name"])
            .where("chat_id", "=", id)
            .orderBy("position")
            .execute();
          const currentAttributes = await trx
            .selectFrom("chat.attributes")
            .select(["key", "value"])
            .where("chat_id", "=", id)
            .where("key", "in", ["bookmarks", "bookmarkNames"])
            .execute();
          const bookmarks = Bookmarks.fromPatch(
            id,
            patch,
            currentBookmarks,
            currentAttributes,
          );
          await trx
            .deleteFrom("chat.bookmarks")
            .where("chat_id", "=", id)
            .execute();
          for (
            let start = 0;
            start < bookmarks.rows.length;
            start += BULK_INSERT_BATCH_ROWS
          ) {
            await trx
              .insertInto("chat.bookmarks")
              .values(
                bookmarks.rows.slice(start, start + BULK_INSERT_BATCH_ROWS),
              )
              .execute();
          }
          encoded.attributes.push(...bookmarks.attributes);
          encoded.clearedAttributeKeys.push(...bookmarks.clearedAttributeKeys);
        }
        if (encoded.clearedAttributeKeys.length) {
          await trx
            .deleteFrom("chat.attributes")
            .where("chat_id", "=", id)
            .where("key", "in", encoded.clearedAttributeKeys)
            .execute();
        }
        for (
          let start = 0;
          start < encoded.attributes.length;
          start += BULK_INSERT_BATCH_ROWS
        ) {
          await trx
            .insertInto("chat.attributes")
            .values(
              encoded.attributes.slice(start, start + BULK_INSERT_BATCH_ROWS),
            )
            .onConflict((oc) =>
              oc
                .columns(["chat_id", "key"])
                .doUpdateSet((eb) => ({ value: eb.ref("excluded.value") })),
            )
            .execute();
        }
      });
    },

    /**
     * Count chats for a character
     * Example usage:
     * const total = await storage.chat.count("cha-id");
     */
    count: async (characterId: string): Promise<number> => {
      const result = await this.db
        .selectFrom("chat.chats")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("character_id", "=", characterId)
        .executeTakeFirstOrThrow();
      return Number(result.count);
    },

    /**
     * Bounded range ordered by position then ID
     * TODO: Implement paged chat list query
     * Example usage:
     * const list = await storage.chat.list("cha-id", { offset: 0, limit: 20 }, "name");
     */
    list: async (
      characterId: string,
      options?: { offset?: number; limit?: number },
    ): Promise<Array<Pick<ChatFields, "id" | "position">>> => {
      let sql = this.db
        .selectFrom("chat.chats")
        .select("chat.chats.id")
        .select("chat.chats.position")
        .where("chat.chats.character_id", "=", characterId)
        .orderBy("chat.chats.position", "asc");

      if (options) {
        if (options.offset) {
          sql = sql.offset(options.offset);
        }

        if (options.limit) {
          sql = sql.limit(options.limit);
        }
      }

      return await sql.execute();
    },

    /**
     * Appends if position is omitted; parent and initial chat state are persisted atomically
     * Example usage:
     * const newChat = await storage.chat.create("cha-id", "Chat 1");
     */
    create: async (
      characterId: string,
      name: string,
      position?: number,
    ): Promise<Chat> => {
      const id = randomUUID();
      await this.db.transaction().execute(async (trx) => {
        await beginRevision(trx, "chat:create");
        const maxPosition = await chat.position.max(characterId, trx);
        if (position !== undefined && maxPosition === -1) {
          throw new Error("position has value. but maxPosition's -1.");
        }

        if (position !== undefined) {
          await trx
            .updateTable("chat.chats")
            .set((eb) => ({
              position: eb("chat.chats.position", "+", 1),
            }))
            .where("chat.chats.character_id", "=", characterId)
            .where("chat.chats.position", ">=", position)
            .executeTakeFirstOrThrow();
        }

        await trx
          .insertInto("chat.chats")
          .values({
            id: id,
            character_id: characterId,
            position: position ?? maxPosition + 1,
            name: name,
          })
          .executeTakeFirstOrThrow();
      });

      return this.chat.ref(id);
    },

    /**
     * Deletes the chat and its owned records atomically; rejects for a missing chat
     * Example usage:
     * await storage.chat.delete("chat-id");
     */
    delete: async (id: string): Promise<void> => {
      await this.db.transaction().execute(async (trx) => {
        await beginRevision(trx, "chat:delete");

        const result = await trx
          .deleteFrom("chat.chats")
          .where("id", "=", id)
          .executeTakeFirst();

        if (result.numDeletedRows === 0n) {
          throw new Error(`Chat not found: ${id}`);
        }
      });
    },

    /**
     * Moves within the same character, updating affected sibling positions atomically
     * Example usage:
     * await storage.chat.move("chat-id", 2);
     */
    move: async (id: string, position: number): Promise<void> => {
      if (!Number.isInteger(position) || position < 0) {
        throw new Error("Invalid position: must be a non-negative integer");
      }

      await this.db.transaction().execute(async (trx) => {
        await lockStorageRevision(trx);

        const current = await trx
          .selectFrom("chat.chats")
          .select(["character_id", "position"])
          .where("id", "=", id)
          .executeTakeFirst();
        if (!current) throw new Error(`Chat not found: ${id}`);

        const maxPosition = await chat.position.max(current.character_id, trx);
        if (position > maxPosition) {
          throw new Error(`Invalid position: must not exceed ${maxPosition}`);
        }
        if (position === current.position) {
          console.warn(
            `PostgresStorage.chat.move: chat ${id} is already at position ${position}. Skipping move.`,
          );
          return;
        }

        await beginRevision(trx, "chat:move");
        await trx
          .updateTable("chat.chats")
          .set((eb) => ({
            position: eb
              .case()
              .when("id", "=", id)
              .then(position)
              .else(eb("position", "+", position < current.position ? 1 : -1))
              .end(),
          }))
          .where("character_id", "=", current.character_id)
          .where("position", ">=", Math.min(current.position, position))
          .where("position", "<=", Math.max(current.position, position))
          .execute();
      });
    },

    /**
     * Lightweight feed; activeChatId pins the opened chat ahead of the limit
     * TODO: Implement recent chats query
     * Example usage:
     * const recents = await storage.chat.listRecent(10, "current-chat-id");
     */
    listRecent: async (
      limit?: number,
      activeChatId?: string,
    ): Promise<RecentChat[]> => {
      throw new Error("Method not implemented.");
    },

    position: {
      /**
       * @param id character id.
       * @return value max position. or -1 if character has no any chats.
       */
      max: async (id: string): Promise<number> => {
        return this.db
          .transaction()
          .execute<number>((trx) => chat.position.max(id, trx));
      },
    },
  };

  /** Chat messages and message search */
  message = {
    /**
     * Saves one message through the revision-guarded commit path
     * TODO: Implement message upsert
     * Example usage:
     * const result = await storage.message.save("chat-id", message);
     */
    save: async (
      chatId: string,
      message: Message & { position: number },
    ): Promise<SqlCommitResult> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Deletes a message by ID
     * TODO: Implement message deletion
     * Example usage:
     * const result = await storage.message.delete("chat-id", "msg-id");
     */
    delete: async (
      chatId: string,
      messageId: string,
    ): Promise<SqlCommitResult> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Lists messages for a chat
     * TODO: Implement message listing query
     * Example usage:
     * const messages = await storage.message.list("chat-id", { mode: "full" });
     */
    list: async (
      chatId: string,
      options?: { mode?: "full" | "generation" },
    ): Promise<Message[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Fetches a paginated slice of messages
     * TODO: Implement message pagination query
     * Example usage:
     * const page = await storage.message.page("chat-id", undefined, 50);
     */
    page: async (
      chatId: string,
      before: number | undefined,
      limit: number,
    ): Promise<SqlMessagePage> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Searches message text across scopes
     * TODO: Implement full-text or ILIKE message search
     * Example usage:
     * const searchResults = await storage.message.search("hello", "all", 20);
     */
    search: async (
      query: string,
      scope?: "all" | "active" | "cold",
      limit?: number,
    ): Promise<NodePostgresMessageSearchResult[]> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Persistent chat branch operations */
  branch = {
    /**
     * Lists all branches for a chat
     * TODO: Implement branch list query
     * Example usage:
     * const branches = await storage.branch.list("chat-id");
     */
    list: async (chatId: string): Promise<SqlChatBranchSummary[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Retrieves branch graph data
     * TODO: Query branch nodes and link relations
     * Example usage:
     * const graph = await storage.branch.graph("chat-id");
     */
    graph: async (chatId: string): Promise<SqlChatBranchGraphData> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Retrieves a paginated slice of branch graph data
     * TODO: Implement paginated graph query
     * Example usage:
     * const page = await storage.branch.graphPage("chat-id", 0, 50);
     */
    graphPage: async (
      chatId: string,
      offset: number,
      limit: number,
    ): Promise<SqlChatBranchGraphPage> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Loads messages belonging to a branch
     * TODO: Query messages scoped to branch
     * Example usage:
     * const branchMsgs = await storage.branch.messages("chat-id", "branch-id");
     */
    messages: async (
      chatId: string,
      branchId: string,
      options?: {
        messageLimit?: number;
        mode?: "full" | "generation" | "graph";
      },
    ): Promise<Message[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Creates a new chat branch
     * TODO: Insert chat branch record
     * Example usage:
     * const newBranch = await storage.branch.create(branchInput);
     */
    create: async (
      input: SqlCreateChatBranchInput,
    ): Promise<SqlChatBranchSummary> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Activates a branch for the chat
     * TODO: Update active branch pointer in chat
     * Example usage:
     * await storage.branch.activate("chat-id", "branch-id");
     */
    activate: async (chatId: string, branchId: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Plugin registry and metadata */
  readonly plugin: IPluginStorage = {
    script: {
      /**
       * Load plugin script by ID
       * TODO: Query plugin script record
       * Example usage:
       * const script = await storage.plugin.script.load("plugin-id");
       */
      load: async (pluginId: string): Promise<PluginScript | null> => {
        throw new Error("Method not implemented.");
      },

      /**
       * Upsert plugin script
       * TODO: Insert or update plugin script
       * Example usage:
       * await storage.plugin.script.upsert(script);
       */
      upsert: async (script: PluginScript): Promise<void> => {
        throw new Error("Method not implemented.");
      },

      /**
       * Batch upsert plugin scripts
       * TODO: Batch insert or update plugin scripts
       * Example usage:
       * await storage.plugin.script.upsertMany([script1, script2]);
       */
      upsertMany: async (scripts: readonly PluginScript[]): Promise<void> => {
        throw new Error("Method not implemented.");
      },
    },

    /**
     * Load plugin metadata by ID
     * TODO: Query plugin metadata
     * Example usage:
     * const plugin = await storage.plugin.load("plugin-id");
     */
    load: async (pluginId: string): Promise<PluginMetadata | null> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Load all plugins
     * TODO: Query all plugin metadata records
     * Example usage:
     * const plugins = await storage.plugin.loadAll();
     */
    loadAll: async (options?: PluginLoadOptions): Promise<PluginMetadata[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Upsert plugin metadata
     * TODO: Insert or update plugin record
     * Example usage:
     * await storage.plugin.upsert(metadata);
     */
    upsert: async (plugin: PluginMetadata): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Batch upsert plugin metadata
     * TODO: Batch insert or update plugin records
     * Example usage:
     * await storage.plugin.upsertMany([plugin1, plugin2]);
     */
    upsertMany: async (plugins: readonly PluginMetadata[]): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Delete plugin by ID
     * TODO: Delete plugin and related scripts
     * Example usage:
     * await storage.plugin.delete("plugin-id");
     */
    delete: async (pluginId: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Batch delete plugins by ID
     * TODO: Batch delete plugins
     * Example usage:
     * await storage.plugin.deleteMany(["id-1", "id-2"]);
     */
    deleteMany: async (pluginIds: readonly string[]): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Set plugin enabled state
     * TODO: Update enabled flag in plugin table
     * Example usage:
     * await storage.plugin.setEnabled("plugin-id", true);
     */
    setEnabled: async (pluginId: string, enabled: boolean): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Reorder plugins by given ID sequence
     * TODO: Update positional order for plugins
     * Example usage:
     * await storage.plugin.reorder(["id-2", "id-1"]);
     */
    reorder: async (pluginIds: readonly string[]): Promise<void> => {
      throw new Error("Method not implemented.");
    },
  };

  /**
   * Loader of every chat relation, keyed by the relation name used in
   * `CHAT_FIELD_STORAGE`. `Record<ChatRelationKey, …>` makes an added relation
   * a compile error until its reader exists.
   */
  private readonly chatRelationReaders = {
    lore: (id: string) => this.readChatLore(id),
    suggestions: (id: string) => this.readChatSuggestions(id),
    modules: (id: string) => this.readChatModules(id),
    scriptState: (id: string) => this.readChatScriptState(id),
    bookmarks: (id: string) => this.readChatBookmarks(id),
    memory: (id: string) => this.readChatMemory(id),
  } satisfies Record<ChatRelationKey, (id: string) => Promise<unknown[]>>;

  /** Reads only the relations the requested fields need, in one round trip. */
  private async readChatRelations<K extends ChatRelationKey>(
    id: string,
    keys: readonly K[],
  ) {
    const entries = await Promise.all(
      keys.map(
        async (key) => [key, await this.chatRelationReaders[key](id)] as const,
      ),
    );

    return Object.fromEntries(entries) as Partial<{
      [P in K]: Awaited<ReturnType<(typeof this.chatRelationReaders)[P]>>;
    }>;
  }

  private readChatAttributes(
    id: string,
    keys: readonly string[],
  ): Promise<Selectable<Pick<AttributesTable, "key" | "value">>[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return this.db
      .selectFrom("chat.attributes")
      .select(["key", "value"])
      .where("chat_id", "=", id)
      .where("key", "in", keys)
      .execute();
  }

  private readChatLore(id: string): Promise<Selectable<LoreEntriesTable>[]> {
    return this.db
      .selectFrom("chat.lore_entries")
      .selectAll()
      .where("chat_id", "=", id)
      .orderBy("position", "asc")
      .execute();
  }

  private readChatSuggestions(id: string) {
    return this.db
      .selectFrom("chat.suggestions")
      .selectAll()
      .where("chat_id", "=", id)
      .orderBy("position", "asc")
      .execute();
  }

  private readChatModules(id: string) {
    return this.db
      .selectFrom("chat.modules")
      .selectAll()
      .where("chat_id", "=", id)
      .orderBy("position", "asc")
      .execute();
  }

  private readChatScriptState(id: string) {
    return this.db
      .selectFrom("chat.script_state")
      .selectAll()
      .where("chat_id", "=", id)
      .execute();
  }

  private readChatBookmarks(id: string) {
    return this.db
      .selectFrom("chat.bookmarks")
      .selectAll()
      .where("chat_id", "=", id)
      .orderBy("position", "asc")
      .execute();
  }

  private readChatMemory(id: string) {
    return this.db
      .selectFrom("chat.memory")
      .selectAll()
      .where("chat_id", "=", id)
      .where("memory_type", "in", ["hypa-v2", "hypa-v3"])
      .execute();
  }

  private readChatActiveBranch(id: string) {
    return this.db
      .selectFrom("chat.active_branches")
      .select("branch_id")
      .where("chat_id", "=", id)
      .executeTakeFirst();
  }

  private readBase(keys: readonly (keyof CharacterFields)[]) {
    return this.db
      .selectFrom("character.characters as c")
      .select(["c.id", "c.kind"])
      .select((eb) => this.attributeProjection(eb, keys));
  }

  private attributeProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    keys: readonly (keyof CharacterFields)[],
  ) {
    return eb
      .selectFrom("character.attributes as a")
      .select((eb) =>
        eb.fn.agg("jsonb_object_agg", ["a.key", "a.value"]).as("attributes"),
      )
      .whereRef("a.character_id", "=", "c.id")
      .where("a.key", "in", keys)
      .as("__attributes");
  }

  private addReadField(
    query: ReturnType<PostgresStorage["readBase"]>,
    key: keyof CharacterFields,
  ) {
    if (Object.hasOwn(CHARACTER_FIELD_COLUMNS, key)) {
      const column =
        CHARACTER_FIELD_COLUMNS[key as keyof typeof CHARACTER_FIELD_COLUMNS];
      query = query.select(`c.${column}`);
    }
    return Object.hasOwn(CHARACTER_RELATIONS, key)
      ? query.select((eb) => this.relationProjection(eb, key))
      : query;
  }

  private relationProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
  ) {
    const relation =
      CHARACTER_RELATIONS[key as keyof typeof CHARACTER_RELATIONS];
    switch (relation.table) {
      case "character.greetings":
        return this.greetingProjection(eb, key, relation.discriminator[1]);
      case "character.scripts":
        return this.scriptProjection(eb, key, relation.discriminator[1]);
      case "character.assets":
        return this.assetProjection(eb, key, relation.discriminator[1]);
      default:
        return eb
          .selectFrom([`${relation.table} as t`])
          .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
          .whereRef("t.character_id", "=", "c.id")
          .as(key);
    }
  }

  private greetingProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
    kind: "alternate" | "group-only",
  ) {
    return eb
      .selectFrom("character.greetings as t")
      .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
      .whereRef("t.character_id", "=", "c.id")
      .where("t.greeting_type", "=", kind)
      .as(key);
  }

  private scriptProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
    kind: "custom" | "trigger",
  ) {
    return eb
      .selectFrom("character.scripts as t")
      .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
      .whereRef("t.character_id", "=", "c.id")
      .where("t.script_kind", "=", kind)
      .as(key);
  }

  private assetProjection(
    eb: ExpressionBuilder<
      PostgresDatabase & { c: CharacterTables["character.characters"] },
      "c"
    >,
    key: keyof CharacterFields,
    source: "additional" | "character-card",
  ) {
    return eb
      .selectFrom("character.assets as t")
      .select((eb) => eb.fn.jsonAgg("t").orderBy("t.position").as("rows"))
      .whereRef("t.character_id", "=", "c.id")
      .where("t.asset_source", "=", source)
      .as(key);
  }

  private readStatement(
    keys: readonly (keyof CharacterFields)[],
    lookup: string | readonly string[],
  ) {
    let query = this.readBase(keys);
    for (const key of keys) query = this.addReadField(query, key);
    return (
      typeof lookup === "string"
        ? query.where("c.id", "=", lookup)
        : query.where("c.id", "in", lookup)
    )
      .$castTo<CharacterReadRow>()
      .compile();
  }

  character = {
    /**
     * Number of stored character and group rows, without hydrating documents
     * TODO: Implement character count query
     * Example usage:
     * const total = await storage.character.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Bounded range ordered by position, then ID; no chats or detailed fields
     * TODO: Implement lightweight character list query
     * Example usage:
     * const items = await storage.character.list({ offset: 0, limit: 50 });
     */
    list: async (options: {
      offset: number;
      limit: number;
    }): Promise<SqlCharacterListItem[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Search characters by tag
     * TODO: Implement character tag search query
     * Example usage:
     * const results = await storage.character.searchByTag("fantasy", 10);
     */
    searchByTag: async (
      tag: string,
      limit?: number,
    ): Promise<NodePostgresCharacterSearchResult[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Search characters by name
     * TODO: Implement character name search query
     * Example usage:
     * const results = await storage.character.searchByName("Alice", 10);
     */
    searchByName: async (
      name: string,
      limit?: number,
    ): Promise<NodePostgresCharacterSearchResult[]> => {
      throw new Error("Method not implemented.");
    },

    ref: (id: string): Character => {
      return new Character(
        id,
        (...keys) => this.character.read(id, ...keys),
        (patch) => this.character.update(id, patch),
      );
    },
    load: async (id: string): Promise<Character> => {
      const query = this.db
        .selectFrom("character.characters")
        .select(["id", "kind"])
        .where("id", "=", id)
        .compile();

      if ((await this.db.executeQuery(query)).rows[0]?.kind !== "character") {
        throw new Error(`Character not found: ${id}`);
      }
      return this.character.ref(id);
    },
    create: async (name: string): Promise<Character> => {
      const query = this.db
        .selectFrom(
          sql<{ id: string; storage_revision: string }>`
        system.character_apply_create(${JSON.stringify(encodeJsonValue(name))}::jsonb)
      `.as("result"),
        )
        .selectAll()
        .compile();
      const { id } = (await this.db.executeQuery(query)).rows[0];
      return this.character.ref(id);
    },
    read: async <K extends keyof CharacterFields>(
      id: string,
      ...keys: [K, ...K[]]
    ): Promise<Pick<CharacterFields, K>> => {
      assertId(id, "characterId");
      const unique = validateCharacterKeys(keys) as K[];
      const result = await this.db.executeQuery(this.readStatement(unique, id));
      const row = result.rows[0];
      if (row?.kind !== "character") {
        throw new Error(`Character not found: ${id}`);
      }
      const values = decodeCharacterReadRow(row, unique);
      return structuredClone(values);
    },
    readMany: async <K extends keyof CharacterFields>(
      ids: readonly string[],
      keys: readonly K[],
    ): Promise<Array<Pick<CharacterFields, K> & { chaId: string }>> => {
      const unique = validateCharacterKeys(keys) as K[];
      for (const id of ids) assertId(id, "characterId");
      const result = await this.db.executeQuery(
        this.readStatement(unique, ids),
      );
      return result.rows
        .filter((row) => row.kind === "character")
        .map((row) => {
          const values = decodeCharacterReadRow(row, unique);
          return structuredClone({ ...values, chaId: row.id });
        });
    },
    exists: async (
      id: string,
      trx?: Transaction<PostgresDatabase>,
    ): Promise<boolean> => {
      let query = (trx ?? this.db)
        .selectFrom("character.characters")
        .select("id")
        .where("id", "=", id)
        .where("kind", "=", "character");

      if (trx) query = query.forUpdate();

      return (await query.executeTakeFirst()) !== undefined;
    },
    update: async (id: string, patch: CharacterUpdate): Promise<void> => {
      validateCharacterUpdate(id, patch);
      if (Object.keys(patch).length === 0) {
        console.warn(
          "PostgresStorage.character.update: Object.keys(patch).length is 0! We will not do character update.",
        );
        return;
      }

      const encoded = characterPatch(id, patch);
      await this.db.transaction().execute(async (trx) => {
        if (!(await this.character.exists(id, trx))) {
          throw new Error(`Character not found: ${id}`);
        }

        await beginRevision(trx, "character:update");

        await trx
          .updateTable("character.characters")
          .set({ ...encoded.columns, updated_at: sql`now()` })
          .where("id", "=", id)
          .execute();

        // Delete all patched relations first so asset kinds can share position keys.
        for (const key of Object.keys(
          encoded.relations,
        ) as (keyof typeof encoded.relations)[]) {
          const relation = CHARACTER_RELATIONS[key];
          let deletion = trx
            .deleteFrom(relation.table)
            .where(sql.ref("character_id"), "=", id);
          if ("discriminator" in relation) {
            deletion = deletion.where(
              sql.ref(relation.discriminator[0]),
              "=",
              relation.discriminator[1],
            );
          }
          await deletion.execute();
        }
        for (const key of Object.keys(
          encoded.relations,
        ) as (keyof typeof encoded.relations)[]) {
          const relation = CHARACTER_RELATIONS[key];
          const rows = encoded.relations[key];
          if (!rows?.length) continue;
          let offset = 0;
          if (relation.table === "character.assets") {
            const remaining = await trx
              .selectFrom("character.assets")
              .select((eb) => eb.fn.max<number>("position").as("position"))
              .where("character_id", "=", id)
              .executeTakeFirstOrThrow();
            offset = (remaining.position ?? -1) + 1;
          }
          if (relation.table === "character.assets" && offset) {
            for (const row of rows) row.position += offset;
          }
          const batchSize = Math.min(BULK_INSERT_BATCH_ROWS, 1000);
          for (let start = 0; start < rows.length; start += batchSize) {
            await trx
              .insertInto(relation.table)
              .values(rows.slice(start, start + batchSize))
              .execute();
          }
        }
        if (encoded.attributeKeys.length) {
          await trx
            .deleteFrom("character.attributes")
            .where("character_id", "=", id)
            .where("key", "in", encoded.attributeKeys)
            .execute();
        }
        if (encoded.attributes.length) {
          await trx
            .insertInto("character.attributes")
            .values(encoded.attributes)
            .execute();
        }
      });
    },
    position: {
      max: async (): Promise<number> => {
        const query = this.db
          .selectFrom("character.characters")
          .select((eb) =>
            eb.fn.coalesce(eb.fn.max<number>("position"), eb.lit(-1)).as("max"),
          )
          .compile();
        return Number((await this.db.executeQuery(query)).rows[0].max);
      },
    },
  };

  /** Author notes operations */
  authorNote = {
    /**
     * Creates a handle without querying or checking existence
     * TODO: Return AuthorNote instance
     * Example usage:
     * const note = storage.authorNote.ref("note-id");
     */
    ref: (id: string): AuthorNote => {
      throw new Error("Method not implemented.");
    },

    /**
     * Checks existence and returns a handle; rejects with AuthorNoteError("missing")
     * TODO: Check note existence and return handle
     * Example usage:
     * const note = await storage.authorNote.load("note-id");
     */
    load: async (id: string): Promise<AuthorNote> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Reads all note fields, including content
     * TODO: Query author note fields
     * Example usage:
     * const fields = await storage.authorNote.read("note-id");
     */
    read: async (id: string): Promise<AuthorNoteFields> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Atomic patch; unspecified fields are preserved
     * TODO: Implement author note update
     * Example usage:
     * await storage.authorNote.update("note-id", { content: "Note" });
     */
    update: async (id: string, patch: AuthorNoteUpdate): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Creates a new author note
     * TODO: Insert new author note record
     * Example usage:
     * const note = await storage.authorNote.create("My Note", "Content");
     */
    create: async (name: string, content?: string): Promise<AuthorNote> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Deletes author note by ID
     * TODO: Delete author note record
     * Example usage:
     * await storage.authorNote.delete("note-id");
     */
    delete: async (id: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Total number of author notes
     * TODO: Implement count query for author notes
     * Example usage:
     * const count = await storage.authorNote.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Bounded range ordered by name then ID; never loads content
     * TODO: Query author notes list
     * Example usage:
     * const list = await storage.authorNote.list({ offset: 0, limit: 20 }, "name");
     */
    list: async <K extends "name" | "updatedAt" = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<Array<Pick<AuthorNoteFields, K> & { id: string }>> => {
      throw new Error("Method not implemented.");
    },

    scriptWrite: {
      /**
       * Get script write permission for author notes
       * TODO: Query script write setting flag
       * Example usage:
       * const enabled = await storage.authorNote.scriptWrite.get();
       */
      get: async (): Promise<boolean> => {
        throw new Error("Method not implemented.");
      },

      /**
       * Set script write permission for author notes
       * TODO: Persist script write setting flag
       * Example usage:
       * await storage.authorNote.scriptWrite.set(true);
       */
      set: async (enabled: boolean): Promise<void> => {
        throw new Error("Method not implemented.");
      },
    },
  };

  /** User personas operations */
  persona = {
    /**
     * Creates a handle without querying or checking existence
     * TODO: Return Persona instance
     * Example usage:
     * const persona = storage.persona.ref("persona-id");
     */
    ref: (id: string): Persona => {
      throw new Error("Method not implemented.");
    },

    /**
     * Checks existence; rejects if missing
     * TODO: Query persona existence and return handle
     * Example usage:
     * const persona = await storage.persona.load("persona-id");
     */
    load: async (id: string): Promise<Persona> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Read all fields of a persona
     * TODO: Query persona fields
     * Example usage:
     * const fields = await storage.persona.read("persona-id");
     */
    read: async (id: string): Promise<PersonaFields> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Update persona fields
     * TODO: Implement persona update query
     * Example usage:
     * await storage.persona.update("persona-id", { name: "New Name" });
     */
    update: async (id: string, patch: PersonaUpdate): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Create a new persona
     * TODO: Insert persona record
     * Example usage:
     * const persona = await storage.persona.create("Default Persona");
     */
    create: async (name: string): Promise<Persona> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Delete a persona
     * TODO: Delete persona record
     * Example usage:
     * await storage.persona.delete("persona-id");
     */
    delete: async (id: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Count total personas
     * TODO: Query total persona count
     * Example usage:
     * const count = await storage.persona.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Ordered by position then ID; no icon or embedded module is read unless requested
     * TODO: Query paged persona list
     * Example usage:
     * const personas = await storage.persona.list({ offset: 0, limit: 10 });
     */
    list: async <K extends keyof PersonaFields = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<
      Array<Pick<PersonaFields, K> & { id: string; position: number }>
    > => {
      throw new Error("Method not implemented.");
    },

    /**
     * Move persona to new position
     * TODO: Update persona positions atomically
     * Example usage:
     * await storage.persona.move("persona-id", 1);
     */
    move: async (id: string, position: number): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    active: {
      /**
       * Get currently selected active persona
       * TODO: Query active persona selection
       * Example usage:
       * const active = await storage.persona.active.get();
       */
      get: async (): Promise<Persona | null> => {
        throw new Error("Method not implemented.");
      },

      /**
       * Set currently selected active persona
       * TODO: Persist active persona ID
       * Example usage:
       * await storage.persona.active.set("persona-id");
       */
      set: async (id: string): Promise<void> => {
        throw new Error("Method not implemented.");
      },
    },
  };

  /** Bot preset configuration operations */
  preset = {
    /**
     * Creates a handle without querying or checking existence
     * TODO: Return Preset instance
     * Example usage:
     * const preset = storage.preset.ref("preset-id");
     */
    ref: (id: string): Preset => {
      throw new Error("Method not implemented.");
    },

    /**
     * Checks existence; rejects if missing
     * TODO: Check preset existence and return handle
     * Example usage:
     * const preset = await storage.preset.load("preset-id");
     */
    load: async (id: string): Promise<Preset> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Reads only requested fields, excluding unrelated prompts and model settings
     * TODO: Query projected preset fields
     * Example usage:
     * const fields = await storage.preset.read("preset-id", "name");
     */
    read: async <K extends keyof PresetFields>(
      id: string,
      ...keys: [K, ...K[]]
    ): Promise<Pick<PresetFields, K>> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Update preset fields
     * TODO: Update preset record
     * Example usage:
     * await storage.preset.update("preset-id", { name: "Preset A" });
     */
    update: async (id: string, patch: PresetUpdate): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Create new preset
     * TODO: Insert preset record
     * Example usage:
     * const preset = await storage.preset.create("Preset A");
     */
    create: async (name: string): Promise<Preset> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Delete preset
     * TODO: Delete preset record
     * Example usage:
     * await storage.preset.delete("preset-id");
     */
    delete: async (id: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Count total presets
     * TODO: Query total preset count
     * Example usage:
     * const count = await storage.preset.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Ordered by position then ID; always includes identity and ordering
     * TODO: Query paged preset list
     * Example usage:
     * const list = await storage.preset.list({ offset: 0, limit: 10 });
     */
    list: async <K extends keyof PresetFields = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<
      Array<Pick<PresetFields, K> & { id: string; position: number }>
    > => {
      throw new Error("Method not implemented.");
    },

    /**
     * Move preset to new position
     * TODO: Reorder presets atomically
     * Example usage:
     * await storage.preset.move("preset-id", 0);
     */
    move: async (id: string, position: number): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    active: {
      /**
       * Get active preset
       * TODO: Query active preset ID
       * Example usage:
       * const active = await storage.preset.active.get();
       */
      get: async (): Promise<Preset | null> => {
        throw new Error("Method not implemented.");
      },

      /**
       * Set active preset
       * TODO: Persist active preset selection
       * Example usage:
       * await storage.preset.active.set("preset-id");
       */
      set: async (id: string): Promise<void> => {
        throw new Error("Method not implemented.");
      },
    },
  };

  /** Global lorebooks operations */
  lorebook = {
    /**
     * Count total global lorebooks
     * TODO: Query lorebook count
     * Example usage:
     * const count = await storage.lorebook.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Book names only; entries remain unloaded. Ordered by position
     * TODO: Query lightweight lorebook list
     * Example usage:
     * const list = await storage.lorebook.list({ offset: 0, limit: 20 });
     */
    list: async (options: {
      offset: number;
      limit: number;
    }): Promise<Array<Pick<LorebookFields, "position" | "name">>> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Read full lorebook by position
     * TODO: Query lorebook and entry records
     * Example usage:
     * const book = await storage.lorebook.read(0);
     */
    read: async (position: number): Promise<LorebookFields> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Update lorebook by position
     * TODO: Update lorebook record and entries
     * Example usage:
     * await storage.lorebook.update(0, patch);
     */
    update: async (position: number, patch: LorebookUpdate): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Appends an empty book and returns its position
     * TODO: Insert new lorebook at the end
     * Example usage:
     * const pos = await storage.lorebook.create("New Lorebook");
     */
    create: async (name: string): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Delete lorebook at position
     * TODO: Delete lorebook and shift subsequent positions
     * Example usage:
     * await storage.lorebook.delete(0);
     */
    delete: async (position: number): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Move lorebook from one position to another
     * TODO: Reorder lorebooks atomically
     * Example usage:
     * await storage.lorebook.move(0, 2);
     */
    move: async (position: number, to: number): Promise<void> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Custom modules operations */
  module = {
    /**
     * Creates a handle without querying or checking existence
     * TODO: Return Module instance
     * Example usage:
     * const mod = storage.module.ref("mod-id");
     */
    ref: (id: string): Module => {
      throw new Error("Method not implemented.");
    },

    /**
     * Checks existence; rejects if missing
     * TODO: Query module existence and return handle
     * Example usage:
     * const mod = await storage.module.load("mod-id");
     */
    load: async (id: string): Promise<Module> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Read full module fields
     * TODO: Query module record
     * Example usage:
     * const fields = await storage.module.read("mod-id");
     */
    read: async (id: string): Promise<ModuleFields> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Update module
     * TODO: Update module record
     * Example usage:
     * await storage.module.update("mod-id", patch);
     */
    update: async (id: string, patch: ModuleUpdate): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Create module
     * TODO: Insert module record
     * Example usage:
     * const mod = await storage.module.create("My Module");
     */
    create: async (name: string): Promise<Module> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Delete module
     * TODO: Delete module record
     * Example usage:
     * await storage.module.delete("mod-id");
     */
    delete: async (id: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Count total modules
     * TODO: Query module count
     * Example usage:
     * const count = await storage.module.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Ordered by position then ID; scripts, lore and assets are read only if requested
     * TODO: Query paged module list
     * Example usage:
     * const list = await storage.module.list({ offset: 0, limit: 10 });
     */
    list: async <K extends keyof ModuleFields = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<
      Array<Pick<ModuleFields, K> & { id: string; position: number }>
    > => {
      throw new Error("Method not implemented.");
    },

    /**
     * Move module to new position
     * TODO: Reorder modules atomically
     * Example usage:
     * await storage.module.move("mod-id", 1);
     */
    move: async (id: string, position: number): Promise<void> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Typed view of prompt settings */
  prompt = {
    /**
     * Read root prompt settings
     * TODO: Query prompt settings fields
     * Example usage:
     * const promptSettings = await storage.prompt.read();
     */
    read: async (): Promise<PromptFields> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Update root prompt settings
     * TODO: Update prompt settings fields
     * Example usage:
     * await storage.prompt.update(patch);
     */
    update: async (patch: PromptUpdate): Promise<void> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Global regex rules and scripts */
  script = {
    /**
     * Count total global scripts
     * TODO: Query script count
     * Example usage:
     * const count = await storage.script.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Ordered by position; rule input/output text is loaded only through read()
     * TODO: Query script list metadata
     * Example usage:
     * const list = await storage.script.list({ offset: 0, limit: 20 });
     */
    list: async (options: {
      offset: number;
      limit: number;
    }): Promise<
      Array<
        Pick<customscript, "comment" | "type" | "ableFlag"> & {
          position: number;
        }
      >
    > => {
      throw new Error("Method not implemented.");
    },

    /**
     * Read custom script by position
     * TODO: Query script by position
     * Example usage:
     * const script = await storage.script.read(0);
     */
    read: async (position: number): Promise<customscript> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Update custom script at position
     * TODO: Update script record
     * Example usage:
     * await storage.script.update(0, { comment: "Updated" });
     */
    update: async (
      position: number,
      patch: Partial<customscript>,
    ): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Appends when position is omitted and returns the inserted position
     * TODO: Insert script record
     * Example usage:
     * const pos = await storage.script.create(scriptData);
     */
    create: async (value: customscript, position?: number): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Delete script at position
     * TODO: Delete script and shift remaining positions
     * Example usage:
     * await storage.script.delete(0);
     */
    delete: async (position: number): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Move script from one position to another
     * TODO: Reorder scripts atomically
     * Example usage:
     * await storage.script.move(0, 1);
     */
    move: async (position: number, to: number): Promise<void> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Arbitrary plugin-owned values */
  pluginCustomStorage = {
    /**
     * Total number of plugin custom storage keys
     * TODO: Query key count in plugin custom storage
     * Example usage:
     * const count = await storage.pluginCustomStorage.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Keys only, ordered lexically
     * TODO: Query paged plugin custom storage keys
     * Example usage:
     * const keys = await storage.pluginCustomStorage.keys({ offset: 0, limit: 50 });
     */
    keys: async (options: {
      offset: number;
      limit: number;
    }): Promise<string[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Missing keys return undefined
     * TODO: Query plugin custom storage value by key
     * Example usage:
     * const val = await storage.pluginCustomStorage.get("myKey");
     */
    get: async (key: string): Promise<PluginStorageValue> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Set plugin custom storage value
     * TODO: Upsert plugin custom storage key-value
     * Example usage:
     * await storage.pluginCustomStorage.set("myKey", { foo: "bar" });
     */
    set: async (key: string, value: PluginStorageValue): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Missing keys are a no-op
     * TODO: Delete plugin custom storage key
     * Example usage:
     * await storage.pluginCustomStorage.delete("myKey");
     */
    delete: async (key: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Clear all plugin custom storage entries
     * TODO: Truncate or delete all rows in plugin custom storage
     * Example usage:
     * await storage.pluginCustomStorage.clear();
     */
    clear: async (): Promise<void> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Root setting values */
  setting = {
    /**
     * Missing keys return undefined
     * TODO: Query setting value by key
     * Example usage:
     * const theme = await storage.setting.get("theme");
     */
    get: async (key: string): Promise<unknown> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Set root setting value
     * TODO: Upsert setting key-value
     * Example usage:
     * await storage.setting.set("theme", "dark");
     */
    set: async (key: string, value: unknown): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Missing keys are a no-op
     * TODO: Delete setting by key
     * Example usage:
     * await storage.setting.delete("theme");
     */
    delete: async (key: string): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Enumerates persisted root setting keys without hydrating values
     * TODO: Query all persisted setting keys
     * Example usage:
     * const keys = await storage.setting.keys();
     */
    keys: async (): Promise<string[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Reads only requested keys; absent keys are omitted from the result
     * TODO: Query batch of setting keys
     * Example usage:
     * const map = await storage.setting.getMany(["theme", "fontSize"]);
     */
    getMany: async (keys: string[]): Promise<Map<string, unknown>> => {
      throw new Error("Method not implemented.");
    },
  };

  /** Cold storage archive operations */
  coldStorage = {
    /**
     * Total number of cold storage archives
     * TODO: Query cold storage archive count
     * Example usage:
     * const count = await storage.coldStorage.count();
     */
    count: async (): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Keys only, ordered lexically
     * TODO: Query paged cold storage archive keys
     * Example usage:
     * const keys = await storage.coldStorage.keys({ offset: 0, limit: 50 });
     */
    keys: async (options: {
      offset: number;
      limit: number;
    }): Promise<string[]> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Missing archives return null
     * TODO: Query cold storage payload by key
     * Example usage:
     * const payload = await storage.coldStorage.get("archive-key");
     */
    get: async (key: string): Promise<unknown | null> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Set cold storage payload
     * TODO: Upsert cold storage key and payload
     * Example usage:
     * await storage.coldStorage.set("archive-key", payload);
     */
    set: async (key: string, value: unknown): Promise<void> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Deletes specified archives and returns the number removed; duplicate keys count once
     * TODO: Delete cold storage keys in batch
     * Example usage:
     * const removed = await storage.coldStorage.delete(["key-1", "key-2"]);
     */
    delete: async (keys: readonly string[]): Promise<number> => {
      throw new Error("Method not implemented.");
    },

    /**
     * Prune archives not in the retained list
     * TODO: Delete all cold storage keys except retained ones
     * Example usage:
     * const pruned = await storage.coldStorage.prune(["key-1"]);
     */
    prune: async (retainedKeys: readonly string[]): Promise<number> => {
      throw new Error("Method not implemented.");
    },
  };
}
