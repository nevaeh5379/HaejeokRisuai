import * as authorNoteSql from "@risuai/protocol/src/authorNoteSql.ts";
import { v4 as uuidv4 } from "uuid";
import * as sqliteCommit from "@risuai/storage-sqlite/commit/apply";
import type { SqliteExecute } from "@risuai/storage-sqlite/types";
import { createEmptySqlCommit, type SqlCommit } from "../sqlCommit";
import type {
  PortableDatabaseStreamFragment,
  PortableDatabaseStreamManifest,
  PortableDatabaseStreamPersistedRecord,
} from "../../backup/portableDatabaseStream";
import {
  PortableDatabaseStreamValidator,
  type PortableDatabaseStreamRestoreProgress,
} from "../../backup/portableDatabaseStreamRestore";

const APPLY_BATCH_SIZE = 128;
const TEMP_BRANCHES = "risu_restore_chat_branches";
const TEMP_ACTIVE = "risu_restore_active_branches";
const TEMP_LINKS = "risu_restore_message_links";

type PersistedRecord = PortableDatabaseStreamPersistedRecord;
type PersistedType = PersistedRecord["type"];

function buildCommit(
  baseRevision: number,
  type: PersistedType,
  records: PersistedRecord[],
): SqlCommit {
  const commit = createEmptySqlCommit(
    baseRevision,
    "local-backup-stream-restore",
  );
  switch (type) {
    case "author-note": {
      const rows: any[] = [];
      for (const record of records) {
        if (record.type === "author-note") {
          rows.push(record.data);
        }
      }
      commit.authorNotes = [
        {
          type: "restore",
          clear: false,
          rows,
          allowScriptWrite: false,
        },
      ];
      break;
    }
    case "author-note-settings": {
      const authorNotes: any[] = [];
      for (const record of records) {
        if (record.type === "author-note-settings") {
          authorNotes.push({
            type: "settings",
            allowScriptWrite: record.allowScriptWrite,
          });
        }
      }
      commit.authorNotes = authorNotes;
      break;
    }
    case "setting":
      for (const record of records) {
        if (record.type === "setting") {
          const { key, value } = record;
          if (key !== "plugins") {
            commit.root.upserts.push({ key, value });
            continue;
          }
          if (!Array.isArray(value))
            throw new Error("Backup plugins must be an array");
          const plugins: Extract<PersistedRecord, { type: "plugin" }>[] =
            value.map((plugin, position) => {
              if (
                !plugin ||
                typeof plugin !== "object" ||
                Array.isArray(plugin) ||
                typeof plugin.script !== "string"
              ) {
                throw new Error(
                  `Invalid backup plugin at position ${position}`,
                );
              }
              const { script, ...data } = plugin;
              return { type: "plugin", id: uuidv4(), position, data, script };
            });
          commit.plugins = buildCommit(baseRevision, "plugin", plugins).plugins;
        }
      }
      break;
    case "plugin": {
      const upserts: any[] = [];
      const scripts: any[] = [];
      for (const record of records) {
        if (record.type === "plugin") {
          upserts.push({
            id: record.id,
            position: record.position,
            data: record.data as any,
          });
          scripts.push({
            id: record.id,
            script: record.script,
          });
        }
      }
      commit.plugins = {
        upserts,
        scripts,
        deletes: [],
      };
      break;
    }
    case "plugin-storage": {
      const upserts: any[] = [];
      for (const record of records) {
        if (record.type === "plugin-storage") {
          upserts.push({
            key: record.key,
            value: record.value,
          });
        }
      }
      commit.pluginStorage = {
        upserts,
        deletes: [],
        clear: false,
      };
      break;
    }
    case "module": {
      const upserts: any[] = [];
      for (const record of records) {
        if (record.type === "module") {
          upserts.push({
            id: record.id,
            position: record.position,
            data: record.data as any,
          });
        }
      }
      commit.modules = {
        upserts,
        deletes: [],
      };
      break;
    }
    case "preset": {
      const upserts: any[] = [];
      for (const record of records) {
        if (record.type === "preset") {
          upserts.push({
            id: record.id,
            position: record.position,
            data: record.data as any,
          });
        }
      }
      commit.presets = {
        upserts,
        deletes: [],
      };
      break;
    }
    case "character":
      for (const record of records) {
        if (record.type === "character") {
          commit.characters.push({
            id: record.id,
            position: record.position,
            data: record.data,
          });
        }
      }
      break;
    case "chat":
      for (const record of records) {
        if (record.type === "chat") {
          commit.chats.push({
            id: record.id,
            characterId: record.characterId,
            position: record.position,
            data: record.data,
          });
        }
      }
      break;
    case "message":
      for (const record of records) {
        if (record.type === "message") {
          commit.messages.push({
            id: record.id,
            chatId: record.chatId,
            position: record.position,
            data: record.data,
          });
        }
      }
      break;
  }
  return commit;
}
export class PortableDatabaseStreamSqliteApplier {
  private readonly validator = new PortableDatabaseStreamValidator();
  private pendingType: PersistedType | null = null;
  private pending: PersistedRecord[] = [];
  private appliedRecords = 0;

  constructor(
    private readonly baseRevision: number,
    private readonly execute: SqliteExecute,
    private readonly onProgress?: (
      progress: PortableDatabaseStreamRestoreProgress,
    ) => void,
  ) {}

  async initialize(): Promise<void> {
    await authorNoteSql.resetAuthorNotes({
      dialect: "sqlite",
      query: async () => [],
      execute: async (sql, bind) => {
        await this.execute(sql, bind);
      },
    });
    await this.execute("DELETE FROM system_settings");
    await this.execute("DELETE FROM plugin_custom_storage");
    await this.execute("DELETE FROM plugin_records");
    await this.execute("DELETE FROM characters");
    await this.execute("DELETE FROM bot_presets");
    await this.execute("DELETE FROM module_records");
    await this.execute(
      `CREATE TEMP TABLE IF NOT EXISTS ${TEMP_BRANCHES} (
        chat_id TEXT NOT NULL, id TEXT NOT NULL, parent_branch_id TEXT,
        fork_message_id TEXT, head_message_id TEXT, reason TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, id)
      )`,
    );
    await this.execute(
      `CREATE TEMP TABLE IF NOT EXISTS ${TEMP_ACTIVE} (
        chat_id TEXT PRIMARY KEY, branch_id TEXT NOT NULL
      )`,
    );
    await this.execute(
      `CREATE TEMP TABLE IF NOT EXISTS ${TEMP_LINKS} (
        chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        parent_message_id TEXT, origin_branch_id TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      )`,
    );
    await this.execute(`DELETE FROM ${TEMP_BRANCHES}`);
    await this.execute(`DELETE FROM ${TEMP_ACTIVE}`);
    await this.execute(`DELETE FROM ${TEMP_LINKS}`);
  }

  async writeFragment(fragment: PortableDatabaseStreamFragment): Promise<void> {
    this.validator.acceptFragment(fragment);
    for (const record of fragment.records) {
      if (record.type === "meta") {
        this.appliedRecords++;
        continue;
      }
      if (
        this.pendingType !== record.type ||
        this.pending.length >= APPLY_BATCH_SIZE
      ) {
        await this.flush();
      }
      this.pendingType = record.type;
      this.pending.push(record);
    }
    if (this.pending.length >= APPLY_BATCH_SIZE) await this.flush();
  }
  private async flush(): Promise<void> {
    if (!this.pendingType || this.pending.length === 0) return;
    const type = this.pendingType;
    const records = this.pending;
    this.pendingType = null;
    this.pending = [];

    if (type === "branch") {
      for (const record of records) {
        if (record.type === "branch") {
          const data = record.data as any;
          await this.execute(
            `INSERT OR REPLACE INTO ${TEMP_BRANCHES}
              (chat_id,id,parent_branch_id,fork_message_id,head_message_id,reason,created_at)
              VALUES (?,?,?,?,?,?,?)`,
            [
              record.chatId,
              data.id,
              data.parentBranchId ?? null,
              data.forkMessageId ?? null,
              data.headMessageId ?? null,
              data.reason,
              Number(data.createdAt) || 0,
            ],
          );
        }
      }
    } else if (type === "active-branch") {
      for (const record of records) {
        if (record.type === "active-branch") {
          await this.execute(
            `INSERT OR REPLACE INTO ${TEMP_ACTIVE} (chat_id,branch_id) VALUES (?,?)`,
            [record.chatId, record.branchId],
          );
        }
      }
    } else {
      const commit = buildCommit(this.baseRevision, type, records);
      await authorNoteSql.applyAuthorNotes(
        {
          dialect: "sqlite",
          query: async () => [],
          execute: async (sql, bind) => {
            await this.execute(sql, bind);
          },
        },
        commit.authorNotes,
      );
      await sqliteCommit.apply(commit as any, this.execute);
      if (type === "message") {
        for (const record of records) {
          if (record.type === "message") {
            await this.execute(
              `INSERT OR REPLACE INTO ${TEMP_LINKS}
                (chat_id,message_id,parent_message_id,origin_branch_id)
                VALUES (?,?,?,?)`,
              [
                record.chatId,
                record.id,
                record.parentMessageId ?? null,
                record.originBranchId,
              ],
            );
          }
        }
      }
    }

    this.appliedRecords += records.length;
    this.onProgress?.({
      appliedRecords: this.appliedRecords,
      recordType: type,
    });
  }

  async finish(manifest: PortableDatabaseStreamManifest): Promise<number> {
    await this.flush();
    this.validator.finish(manifest);
    await this.execute("DELETE FROM chat_active_branches");
    await this.execute("DELETE FROM message_branch_links");
    await this.execute("DELETE FROM chat_branches");
    await this.execute(
      `INSERT INTO chat_branches
        (chat_id,id,parent_branch_id,fork_message_id,head_message_id,reason,created_at)
        SELECT chat_id,id,parent_branch_id,fork_message_id,head_message_id,reason,created_at
        FROM ${TEMP_BRANCHES}`,
    );
    await this.execute(
      `INSERT INTO message_branch_links
        (chat_id,message_id,parent_message_id,origin_branch_id)
        SELECT chat_id,message_id,parent_message_id,origin_branch_id
        FROM ${TEMP_LINKS}`,
    );
    await this.execute(
      `INSERT INTO chat_active_branches (chat_id,branch_id)
        SELECT chat_id,branch_id FROM ${TEMP_ACTIVE}`,
    );
    await this.execute(`DROP TABLE IF EXISTS ${TEMP_LINKS}`);
    await this.execute(`DROP TABLE IF EXISTS ${TEMP_ACTIVE}`);
    await this.execute(`DROP TABLE IF EXISTS ${TEMP_BRANCHES}`);

    const revision = this.baseRevision + 1;
    await this.execute(
      "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
      [revision],
    );
    await this.execute(
      "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', 'local-backup-stream-restore', datetime('now'))",
      [revision],
    );
    return revision;
  }
}

type RestoreTransactionRunner = (
  task: (execute: SqliteExecute) => Promise<number>,
) => Promise<number>;

type RestoreCommand =
  | {
      kind: "fragment";
      fragment: PortableDatabaseStreamFragment;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "finish";
      manifest: PortableDatabaseStreamManifest;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "abort";
      resolve: () => void;
      reject: (error: unknown) => void;
    };

class RestoreCommandQueue {
  private readonly commands: RestoreCommand[] = [];
  private waiter: (() => void) | null = null;

  push(command: RestoreCommand) {
    this.commands.push(command);
    this.waiter?.();
    this.waiter = null;
  }
  async next(): Promise<RestoreCommand> {
    while (this.commands.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.commands.shift()!;
  }
}

export async function createPortableDatabaseStreamSqliteSession(options: {
  baseRevision: number;
  runTransaction: RestoreTransactionRunner;
  onProgress?: (progress: PortableDatabaseStreamRestoreProgress) => void;
  onCommitted?: (revision: number) => void;
}) {
  const queue = new RestoreCommandQueue();
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let terminalError: unknown = null;
  const transaction = options
    .runTransaction(async (execute) => {
      const applier = new PortableDatabaseStreamSqliteApplier(
        options.baseRevision,
        execute,
        options.onProgress,
      );
      await applier.initialize();
      readyResolve();

      while (true) {
        const command = await queue.next();
        try {
          if (command.kind === "fragment") {
            await applier.writeFragment(command.fragment);
            command.resolve();
            continue;
          }
          if (command.kind === "finish") {
            const revision = await applier.finish(command.manifest);
            command.resolve();
            return revision;
          }
          command.resolve();
          throw new Error("Streaming database restore aborted");
        } catch (error) {
          command.reject(error);
          throw error;
        }
      }
    })
    .then((revision) => {
      options.onCommitted?.(revision);
      return revision;
    })
    .catch((error) => {
      terminalError = error;
      readyReject(error);
      throw error;
    });
  await ready;

  const send = (
    command:
      | Omit<
          Extract<RestoreCommand, { kind: "fragment" }>,
          "resolve" | "reject"
        >
      | Omit<Extract<RestoreCommand, { kind: "finish" }>, "resolve" | "reject">
      | Omit<Extract<RestoreCommand, { kind: "abort" }>, "resolve" | "reject">,
  ) =>
    new Promise<void>((resolve, reject) => {
      if (terminalError) {
        reject(terminalError);
        return;
      }
      queue.push({ ...command, resolve, reject } as RestoreCommand);
    });

  return {
    async writeFragment(fragment: PortableDatabaseStreamFragment) {
      await send({ kind: "fragment", fragment });
    },
    async finish(manifest: PortableDatabaseStreamManifest) {
      await send({ kind: "finish", manifest });
      await transaction;
    },
    async abort() {
      if (terminalError) {
        await transaction.catch(() => {});
        return;
      }
      await send({ kind: "abort" }).catch(() => {});
      await transaction.catch(() => {});
    },
  };
}
