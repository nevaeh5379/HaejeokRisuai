import type {
  PortableDatabase,
  character,
  groupChat,
  Chat,
  Message,
} from "../database/schema";
import type {
  ISqlStorage,
  SqlChatBranchGraphLink,
  SqlChatBranchSummary,
} from "../sql/ISqlStorage";
import { iterateStorageSyncSqlRecords } from "../runtime/storageSyncSource";
import {
  NATIVE_BRANCH_GRAPHS_KEY,
  stripLegacyBranchFields,
} from "@risuai/backup-core/portableBranches";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  portableDatabaseStreamFragmentName,
  type PortableDatabaseStreamFragment as CorePortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest as CorePortableDatabaseStreamManifest,
  type PortableDatabaseStreamRecord,
} from "@risuai/backup-core/streamFormat";
import {
  DEFAULT_LOCAL_BACKUP_PERFORMANCE,
  LOCAL_BACKUP_PERFORMANCE_LIMITS,
} from "./localBackupPerformance";

export {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  portableDatabaseStreamFragmentName,
};
export const PORTABLE_DATABASE_STREAM_PAGE_SIZE =
  DEFAULT_LOCAL_BACKUP_PERFORMANCE.databasePageRecords;
export const PORTABLE_DATABASE_STREAM_FRAGMENT_RECORDS =
  DEFAULT_LOCAL_BACKUP_PERFORMANCE.fragmentRecords;
export const PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS =
  LOCAL_BACKUP_PERFORMANCE_LIMITS.fragmentRecords.max;

export type PortableDatabaseStreamPersistedRecord =
  PortableDatabaseStreamRecord;
export type PortableDatabaseStreamFragment = CorePortableDatabaseStreamFragment;
export type PortableDatabaseStreamManifest = CorePortableDatabaseStreamManifest;

type PersistedRecord = PortableDatabaseStreamPersistedRecord;
type PersistedRecordType = PersistedRecord["type"];

export interface PortableDatabaseStreamProgress {
  stage: string;
  current: number;
  total: number;
}

export interface PortableDatabaseStreamExportHooks {
  writeFragment(fragment: PortableDatabaseStreamFragment): Promise<void>;
  writeColdStorage(key: string, value: unknown): Promise<void>;
  onRecord?(record: PersistedRecord): void;
  onProgress?(progress: PortableDatabaseStreamProgress): void;
}

const RECORD_TYPES: PersistedRecordType[] = [
  "meta",
  "setting",
  "plugin-storage",
  "module",
  "preset",
  "character",
  "chat",
  "branch",
  "active-branch",
  "message",
];

function increment(
  counts: Partial<Record<PersistedRecordType, number>>,
  type: PersistedRecordType,
) {
  counts[type] = (counts[type] ?? 0) + 1;
}

function shallowCloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Streamed chat record data must be an object");
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * Reuses the storage-sync iterator shared by every SQL backend. It performs
 * authoritative revision checks and pages branch messages; the backup layer
 * only groups those bounded records into small container entries.
 */
export async function exportPortableDatabaseStream(
  storage: ISqlStorage,
  hooks: PortableDatabaseStreamExportHooks,
  options: { pageSize?: number; fragmentRecords?: number } = {},
): Promise<PortableDatabaseStreamManifest> {
  if (!storage.isEnabled()) {
    const initialized = await storage.init();
    if (!initialized || !storage.isEnabled()) {
      throw new Error("Failed to initialize SQL storage for streaming backup");
    }
  }
  const summary = await storage.getStorageSyncSummary();
  if (!summary?.initialized) {
    throw new Error("Cannot stream an empty database backup");
  }

  let fragmentIndex = 0;
  let totalRecords = 0;
  let fragmentRecords: PersistedRecord[] = [];
  const pageSize = Math.max(
    1,
    Math.min(
      500,
      Math.round(options.pageSize ?? PORTABLE_DATABASE_STREAM_PAGE_SIZE),
    ),
  );
  const fragmentRecordLimit = Math.max(
    1,
    Math.min(
      PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
      Math.round(
        options.fragmentRecords ?? PORTABLE_DATABASE_STREAM_FRAGMENT_RECORDS,
      ),
    ),
  );
  const counts: Partial<Record<PersistedRecordType, number>> = {};
  const flush = async () => {
    if (fragmentRecords.length === 0) return;
    const fragment: PortableDatabaseStreamFragment = {
      format: "risu-portable-database-fragment",
      version: PORTABLE_DATABASE_STREAM_VERSION,
      index: ++fragmentIndex,
      records: fragmentRecords,
    };
    fragmentRecords = [];
    await hooks.writeFragment(fragment);
  };

  for await (const record of iterateStorageSyncSqlRecords(storage, {
    expectedRevision: summary.revision,
    pageSize,
  })) {
    if (record.type === "cold-storage") {
      await hooks.writeColdStorage(record.key, record.value);
      continue;
    }
    increment(counts, record.type);
    totalRecords++;
    hooks.onRecord?.(record);
    fragmentRecords.push(
      record.type === "chat"
        ? {
            ...record,
            // Runtime chat documents carry activeBranchId from SQL hydration,
            // but the backup format keeps branch fields only in the graph.
            // stripLegacyBranchFields mutates, so clone before normalizing.
            data: stripLegacyBranchFields(
              shallowCloneRecord(record.data) as Record<string, unknown>,
            ),
          }
        : record,
    );
    if (fragmentRecords.length >= fragmentRecordLimit) {
      await flush();
    }
    hooks.onProgress?.({
      stage: record.type,
      current: totalRecords,
      total: summary.records.total,
    });
  }
  await flush();

  return {
    format: "risu-portable-database-stream",
    version: PORTABLE_DATABASE_STREAM_VERSION,
    revision: summary.revision,
    totalFragments: fragmentIndex,
    totalRecords,
    counts,
    complete: true,
  };
}

interface PendingCharacter {
  position: number;
  value: character | groupChat;
  chats: Array<{ position: number; value: Chat }>;
}

interface PendingGraph {
  branches: SqlChatBranchSummary[];
  activeBranchId?: string;
  messages: Array<{ position: number; value: Message }>;
  links: Array<{ position: number; value: SqlChatBranchGraphLink }>;
}

/** Collects bounded fragments for the existing aggregate restore API. */
export class PortableDatabaseStreamCollector {
  private readonly database: Record<string, unknown> = {};
  private readonly characters = new Map<string, PendingCharacter>();
  private readonly chats = new Set<string>();
  private readonly graphs = new Map<string, PendingGraph>();
  private readonly fragments = new Set<number>();
  private readonly counts: Partial<Record<PersistedRecordType, number>> = {};
  private readonly presetIds: string[] = [];
  private totalRecords = 0;
  private sourceRevision: number | null = null;
  private manifest: PortableDatabaseStreamManifest | null = null;

  private graph(chatId: string): PendingGraph {
    if (!this.chats.has(chatId)) {
      throw new Error(`Streamed branch graph has no chat ${chatId}`);
    }
    let graph = this.graphs.get(chatId);
    if (!graph) {
      graph = { branches: [], messages: [], links: [] };
      this.graphs.set(chatId, graph);
    }
    return graph;
  }

  private addRecord(record: PersistedRecord): void {
    if (
      !record ||
      typeof record !== "object" ||
      !RECORD_TYPES.includes(record.type)
    ) {
      throw new Error("Invalid streaming database record");
    }
    increment(this.counts, record.type);
    this.totalRecords++;
    switch (record.type) {
      case "meta":
        if (this.sourceRevision !== null) {
          throw new Error("Duplicate streaming database metadata");
        }
        if (
          record.formatVersion !== 1 ||
          !Number.isSafeInteger(record.revision) ||
          record.revision < 0
        ) {
          throw new Error("Invalid streaming database metadata");
        }
        this.sourceRevision = record.revision;
        break;
      case "setting":
        this.database[record.key] = record.value;
        break;
      case "plugin-storage":
        ((this.database.pluginCustomStorage ??= {}) as Record<string, unknown>)[
          record.key
        ] = record.value;
        break;
      case "module":
        if (!Number.isSafeInteger(record.position) || record.position < 0) {
          throw new Error("Invalid streamed module position");
        }
        (
          (this.database.modules ??= []) as Array<{
            position: number;
            value: unknown;
          }>
        ).push({ position: record.position, value: record.data });
        break;
      case "preset":
        if (!Number.isSafeInteger(record.position) || record.position < 0) {
          throw new Error("Invalid streamed preset position");
        }
        (
          (this.database.botPresets ??= []) as Array<{
            position: number;
            value: unknown;
          }>
        ).push({ position: record.position, value: record.data });
        this.presetIds[record.position] = record.id;
        break;
      case "character": {
        if (!Number.isSafeInteger(record.position) || record.position < 0) {
          throw new Error("Invalid streamed character position");
        }
        if (this.characters.has(record.id)) {
          throw new Error(`Duplicate streamed character ${record.id}`);
        }
        this.characters.set(record.id, {
          position: record.position,
          value: {
            ...(record.data as Record<string, unknown>),
            chaId: record.id,
            chats: [],
            detailsLoaded: true,
          } as unknown as character | groupChat,
          chats: [],
        });
        break;
      }
      case "chat": {
        if (!Number.isSafeInteger(record.position) || record.position < 0) {
          throw new Error("Invalid streamed chat position");
        }
        const owner = this.characters.get(record.characterId);
        if (!owner) {
          throw new Error(
            `Streamed chat has no character ${record.characterId}`,
          );
        }
        if (this.chats.has(record.id)) {
          throw new Error(`Duplicate streamed chat ${record.id}`);
        }
        this.chats.add(record.id);
        owner.chats.push({
          position: record.position,
          value: {
            ...(record.data as Record<string, unknown>),
            id: record.id,
            message: [],
            messageOffset: 0,
            messageTotal: 0,
            messagesLoaded: true,
            messagesFullyLoaded: true,
            detailsLoaded: true,
          } as unknown as Chat,
        });
        break;
      }
      case "branch":
        this.graph(record.chatId).branches.push(
          record.data as SqlChatBranchSummary,
        );
        break;
      case "active-branch":
        this.graph(record.chatId).activeBranchId = record.branchId;
        break;
      case "message": {
        if (!Number.isSafeInteger(record.position) || record.position < 0) {
          throw new Error("Invalid streamed message position");
        }
        const graph = this.graph(record.chatId);
        graph.messages.push({
          position: record.position,
          value: {
            ...(record.data as Record<string, unknown>),
            chatId: record.id,
          } as unknown as Message,
        });
        graph.links.push({
          position: record.position,
          value: {
            messageId: record.id,
            position: record.position,
            parentMessageId: record.parentMessageId,
            originBranchId: record.originBranchId,
          },
        });
        break;
      }
    }
  }

  addFragment(fragment: PortableDatabaseStreamFragment): void {
    if (
      fragment.format !== "risu-portable-database-fragment" ||
      fragment.version !== PORTABLE_DATABASE_STREAM_VERSION ||
      !Number.isSafeInteger(fragment.index) ||
      fragment.index <= 0 ||
      !Array.isArray(fragment.records) ||
      fragment.records.length === 0 ||
      fragment.records.length > PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS
    ) {
      throw new Error("Invalid streaming database fragment");
    }
    if (this.fragments.has(fragment.index)) {
      throw new Error(
        `Duplicate streaming database fragment ${fragment.index}`,
      );
    }
    this.fragments.add(fragment.index);
    for (const record of fragment.records) this.addRecord(record);
  }

  setManifest(manifest: PortableDatabaseStreamManifest): void {
    if (this.manifest) throw new Error("Duplicate streaming database manifest");
    if (
      manifest.format !== "risu-portable-database-stream" ||
      manifest.version !== PORTABLE_DATABASE_STREAM_VERSION ||
      manifest.complete !== true ||
      !Number.isSafeInteger(manifest.revision) ||
      manifest.revision < 0 ||
      !Number.isSafeInteger(manifest.totalFragments) ||
      manifest.totalFragments <= 0 ||
      !Number.isSafeInteger(manifest.totalRecords) ||
      manifest.totalRecords <= 0 ||
      !manifest.counts ||
      typeof manifest.counts !== "object"
    ) {
      throw new Error("Unsupported streaming database manifest");
    }
    this.manifest = manifest;
  }

  finish(): PortableDatabase {
    const manifest = this.manifest;
    if (!manifest) throw new Error("Streaming database manifest is missing");
    if (
      manifest.totalFragments !== this.fragments.size ||
      manifest.totalRecords !== this.totalRecords
    ) {
      throw new Error(
        `Streaming database is incomplete (${this.fragments.size}/${manifest.totalFragments} fragments, ${this.totalRecords}/${manifest.totalRecords} records)`,
      );
    }
    for (let index = 1; index <= manifest.totalFragments; index++) {
      if (!this.fragments.has(index)) {
        throw new Error(`Streaming database fragment ${index} is missing`);
      }
    }
    if (this.sourceRevision !== manifest.revision) {
      throw new Error("Streaming database revision does not match");
    }
    for (const type of RECORD_TYPES) {
      if ((manifest.counts[type] ?? 0) !== (this.counts[type] ?? 0)) {
        throw new Error(`Streaming database ${type} count does not match`);
      }
    }
    for (const chatId of this.chats) {
      const graph = this.graphs.get(chatId);
      if (!graph || graph.branches.length === 0) {
        throw new Error(`Streaming branch graph is missing for chat ${chatId}`);
      }
    }

    this.database.characters = [...this.characters.values()]
      .sort((left, right) => left.position - right.position)
      .map((entry) => {
        entry.value.chats = entry.chats
          .sort((left, right) => left.position - right.position)
          .map((chat) => chat.value);
        return entry.value;
      });
    this.database.modules = (
      (this.database.modules as Array<{
        position: number;
        value: unknown;
      }>) ?? []
    )
      .sort((left, right) => left.position - right.position)
      .map((entry) => entry.value);
    this.database.botPresets = (
      (this.database.botPresets as Array<{
        position: number;
        value: unknown;
      }>) ?? []
    )
      .sort((left, right) => left.position - right.position)
      .map((entry) => entry.value);
    const activePresetId = this.database.activeBotPresetId;
    this.database.botPresetsId =
      typeof activePresetId === "string"
        ? Math.max(0, this.presetIds.indexOf(activePresetId))
        : 0;
    this.database.pluginCustomStorage ??= {};
    this.database[NATIVE_BRANCH_GRAPHS_KEY] = Object.fromEntries(
      [...this.graphs].map(([chatId, graph]) => [
        chatId,
        {
          branches: graph.branches,
          activeBranchId: graph.activeBranchId,
          messages: graph.messages
            .sort((left, right) => left.position - right.position)
            .map((entry) => entry.value),
          links: graph.links
            .sort((left, right) => left.position - right.position)
            .map((entry) => entry.value),
        },
      ]),
    );
    return this.database as unknown as PortableDatabase;
  }
}
