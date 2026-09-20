import { NATIVE_BRANCH_GRAPHS_KEY } from "./portableBranches";
import {
  parsePortableDatabaseStreamFragment,
  parsePortableDatabaseStreamManifest,
  type PortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest,
  type PortableDatabaseStreamRecord,
} from "./streamFormat";

type PersistedRecord = PortableDatabaseStreamRecord;
type PersistedRecordType = PersistedRecord["type"];

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

interface PendingCharacter {
  position: number;
  value: Record<string, any>;
  chats: Array<{ position: number; value: Record<string, any> }>;
}

interface PendingGraph {
  branches: Record<string, any>[];
  activeBranchId?: string;
  messages: Array<{ position: number; value: Record<string, any> }>;
  links: Array<{ position: number; value: Record<string, any> }>;
}

/**
 * Aggregate fallback collector for streamed portable-database backups.
 *
 * Validates bounded fragments/manifest and reconstructs the full portable
 * database in memory. This deliberately materializes the reconstructed
 * database — use it only on hosts without a bounded streaming-restore
 * session; SQL backends that implement `beginPortableDatabaseStreamRestore`
 * consume fragments through that bounded path instead. No payload copies
 * beyond the reconstructed aggregate itself are made.
 */
export class PortableDatabaseStreamCollector {
  private readonly database: Record<string, any> = {};
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
          },
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
          },
        });
        break;
      }
      case "branch":
        this.graph(record.chatId).branches.push(
          record.data as Record<string, any>,
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
          },
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
    const parsed: PortableDatabaseStreamFragment | null =
      parsePortableDatabaseStreamFragment(fragment);
    if (!parsed) throw new Error("Invalid streaming database fragment");
    if (this.fragments.has(parsed.index)) {
      throw new Error(`Duplicate streaming database fragment ${parsed.index}`);
    }
    this.fragments.add(parsed.index);
    for (const record of parsed.records) this.addRecord(record);
  }

  setManifest(manifest: PortableDatabaseStreamManifest): void {
    if (this.manifest) throw new Error("Duplicate streaming database manifest");
    const parsed: PortableDatabaseStreamManifest | null =
      parsePortableDatabaseStreamManifest(manifest);
    if (!parsed) throw new Error("Unsupported streaming database manifest");
    this.manifest = parsed;
  }

  finish(): Record<string, any> {
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
    return this.database;
  }
}
