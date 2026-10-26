"use strict";

/**
 * Vendor-neutral read models.
 *
 * Every SQL driver selects the same columns for these queries and then shapes
 * them into the same API response. Only the dialect differs, so the shaping is
 * implemented once here and the drivers keep their own SQL.
 * 세 벤더 모두 같은 컬럼을 조회해 같은 응답 형태로 가공하므로, 가공 로직은 여기서
 * 한 번만 구현하고 각 드라이버는 자기 SQL만 유지합니다.
 */

import { createHash } from "node:crypto";
import type {
  AuditLogEntryRow,
  BotChatStatsRow,
  BotPresetListRow,
  BranchRow,
  CharacterCoreRow,
  RecentChatRow,
  RestorePreviewSummary,
  RevisionDiffEntry,
  RevisionListRow,
  RevisionRow,
  RevisionTableSummary,
  SettingValueRow,
  StorageSyncSummaryRow,
  TokenUsageRow,
} from "./relationalRows.ts";
import { decodePresetData, mapBranchRow } from "./relationalRows.ts";
import { rebuildSettings } from "./postgres/postgresSettingsCodec.ts";
import { rebuildMessage } from "./postgres/postgresRelationalCodec.ts";

/** Driver-specific decoding of the audit row snapshots. */
type RowDecoder = (value: unknown) => unknown;

/** Default decoder: the driver already handed back a parsed object. */
function keepRowSnapshot(value: unknown): unknown {
  return value;
}

/**
 * Decodes an audit snapshot a driver returned as JSON text.
 * 문자열로 온 감사 스냅샷을 파싱합니다.
 */
function parseJsonSnapshot(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Applies a decoder only to values that are actually present. */
function decodePresent(
  value: unknown,
  decode: (value: unknown) => unknown,
): unknown {
  return value == null ? value : decode(value);
}

/**
 * Parses the `limit` argument of `listRevisions`.
 * `null`/`all`/`0`/non-numeric values all mean "no limit".
 */
function parseRevisionListLimit(rawLimit: unknown): number | null {
  if (
    rawLimit === null ||
    rawLimit === undefined ||
    rawLimit === "" ||
    rawLimit === "all" ||
    rawLimit === 0 ||
    rawLimit === "0"
  ) {
    return null;
  }
  const parsedLimit = Number.parseInt(String(rawLimit), 10);
  return Number.isSafeInteger(parsedLimit) && parsedLimit > 0
    ? parsedLimit
    : null;
}

/** Normalizes one `listRevisions` row. */
function mapRevisionListRow(
  row: RevisionListRow,
  options: { decodeDatabaseInitialized?: (value: unknown) => unknown } = {},
): RevisionListRow {
  const decodeDatabaseInitialized =
    options.decodeDatabaseInitialized ?? ((value: unknown) => value);
  return {
    ...row,
    id: Number(row.id),
    storage_revision:
      row.storage_revision === null ? null : Number(row.storage_revision),
    database_initialized: decodePresent(
      row.database_initialized,
      decodeDatabaseInitialized,
    ) as boolean | null,
    restored_from_revision:
      row.restored_from_revision === null
        ? null
        : Number(row.restored_from_revision),
    change_count: Number(row.change_count),
  };
}

/** One entry of `getRevisionDetails.auditLogs`. */
function mapRevisionAuditEntry(
  row: AuditLogEntryRow,
  decodeRow: RowDecoder = keepRowSnapshot,
): RevisionDiffEntry {
  return {
    sequence: Number(row.sequence),
    revisionId: Number(row.revision_id),
    tableName: row.table_name,
    operation: row.operation,
    beforeRow: decodePresent(row.before_row, decodeRow),
    afterRow: decodePresent(row.after_row, decodeRow),
    recordedAt: row.recorded_at,
  };
}

/** Adds one audit row to the per-table counters. */
function accumulateRevisionTable(
  tableMap: Map<string, RevisionTableSummary>,
  row: { table_name: string; operation: string },
): RevisionTableSummary {
  const table = row.table_name;
  let stat = tableMap.get(table);
  if (!stat) {
    stat = {
      tableName: table,
      insertCount: 0,
      updateCount: 0,
      deleteCount: 0,
      totalCount: 0,
    };
    tableMap.set(table, stat);
  }
  stat.totalCount += 1;
  if (row.operation === "INSERT") stat.insertCount += 1;
  else if (row.operation === "UPDATE") stat.updateCount += 1;
  else if (row.operation === "DELETE") stat.deleteCount += 1;
  return stat;
}

/** Builds the `getRevisionDetails` response. */
function buildRevisionDetails(
  revision: RevisionRow,
  auditRows: readonly AuditLogEntryRow[],
  options: {
    decodeRow?: RowDecoder;
    decodeDatabaseInitialized?: (value: unknown) => unknown;
  } = {},
) {
  const decodeDatabaseInitialized =
    options.decodeDatabaseInitialized ?? ((value: unknown) => value);
  const tableMap = new Map<string, RevisionTableSummary>();
  const auditLogs = auditRows.map((row) => {
    accumulateRevisionTable(tableMap, row);
    return mapRevisionAuditEntry(row, options.decodeRow);
  });
  return {
    id: Number(revision.id),
    storage_revision:
      revision.storage_revision === null
        ? null
        : Number(revision.storage_revision),
    database_initialized: decodePresent(
      revision.database_initialized,
      decodeDatabaseInitialized,
    ),
    scope: revision.scope,
    action: revision.action,
    restored_from_revision:
      revision.restored_from_revision === null
        ? null
        : Number(revision.restored_from_revision),
    created_at: revision.created_at,
    change_count: auditLogs.length,
    tableSummaries: Array.from(tableMap.values()),
    auditLogs,
  };
}

/** Builds the per-table part of the `getRevisionDiff` response. */
function buildRevisionDiffTables(
  auditRows: readonly AuditLogEntryRow[],
  options: { decodeRow?: RowDecoder } = {},
): (RevisionTableSummary & { entries: RevisionDiffEntry[] })[] {
  const tableMap = new Map<
    string,
    RevisionTableSummary & { entries: RevisionDiffEntry[] }
  >();
  for (const row of auditRows) {
    const table = row.table_name;
    let stat = tableMap.get(table);
    if (!stat) {
      stat = {
        tableName: table,
        insertCount: 0,
        updateCount: 0,
        deleteCount: 0,
        totalCount: 0,
        entries: [],
      };
      tableMap.set(table, stat);
    }
    stat.totalCount += 1;
    if (row.operation === "INSERT") stat.insertCount += 1;
    else if (row.operation === "UPDATE") stat.updateCount += 1;
    else if (row.operation === "DELETE") stat.deleteCount += 1;
    stat.entries.push(mapRevisionAuditEntry(row, options.decodeRow));
  }
  return Array.from(tableMap.values());
}

/** Per-table counters and totals reported by `previewRestore`. */
function buildRestorePreview(auditRows: readonly AuditLogEntryRow[]): {
  totalOperations: number;
  restoreInsertCount: number;
  restoreDeleteCount: number;
  restoreUpdateCount: number;
  affectedTables: RestorePreviewSummary[];
} {
  const tableMap = new Map<string, RestorePreviewSummary>();
  let restoreInsertCount = 0;
  let restoreDeleteCount = 0;
  let restoreUpdateCount = 0;

  for (const event of auditRows) {
    const table = event.table_name;
    let stat = tableMap.get(table);
    if (!stat) {
      stat = {
        tableName: table,
        revertedInserts: 0,
        revertedUpdates: 0,
        revertedDeletes: 0,
        totalChanges: 0,
      };
      tableMap.set(table, stat);
    }
    stat.totalChanges += 1;
    if (event.operation === "INSERT") {
      stat.revertedInserts += 1;
      restoreDeleteCount += 1;
    } else if (event.operation === "DELETE") {
      stat.revertedDeletes += 1;
      restoreInsertCount += 1;
    } else if (event.operation === "UPDATE") {
      stat.revertedUpdates += 1;
      restoreUpdateCount += 1;
    }
  }

  return {
    totalOperations: auditRows.length,
    restoreInsertCount,
    restoreDeleteCount,
    restoreUpdateCount,
    affectedTables: Array.from(tableMap.values()),
  };
}

/** Builds the `getBotChatStats` response. */
function mapBotChatStatsRow(row: BotChatStatsRow) {
  const totalSessions = Number(row.total_sessions || 0);
  const totalMessages = Number(row.total_messages || 0);
  return {
    id: row.id,
    name: row.name || (row.kind === "group" ? "Group" : "Character"),
    avatarKey: row.image || undefined,
    image: row.image || undefined,
    isGroup: row.kind === "group",
    totalSessions,
    totalMessages,
    userMessages: Number(row.user_messages || 0),
    botMessages: Number(row.bot_messages || 0),
    longestSessionMessages: Number(row.longest_session_messages || 0),
    lastActiveDate:
      row.last_active_date != null ? Number(row.last_active_date) : null,
    // Postgres and SQL Server round inside the query; Oracle does not, so the
    // read model rounds for everyone.
    avgBotMessageLen: Math.round(Number(row.avg_bot_message_len) || 0),
    avgUserMessageLen: Math.round(Number(row.avg_user_message_len) || 0),
    avgMessagesPerSession: Number(
      totalSessions > 0 ? (totalMessages / totalSessions).toFixed(1) : 0,
    ),
  };
}

/** Builds one `listRecentChats` entry. */
function mapRecentChatRow(row: RecentChatRow) {
  return {
    characterId: row.character_id,
    characterName: row.character_name || "",
    characterImage: row.character_image || null,
    characterType: row.character_kind === "group" ? "group" : "character",
    chatId: row.chat_id,
    chatPosition: Number(row.chat_position) || 0,
    chatName: row.chat_name || "",
    folderId: row.folder_id || null,
    lastDate:
      row.last_message_time == null ? null : Number(row.last_message_time),
    lastMessage: row.last_message_text || "",
  };
}

/** Builds the `getStorageSyncSummary` response. */
function summarizeStorageSyncRow(
  row: Partial<StorageSyncSummaryRow>,
  options: { decodeInitialized?: (value: unknown) => unknown } = {},
) {
  const records = {
    settings: Number(row.settings_count) || 0,
    characters: Number(row.characters_count) || 0,
    chats: Number(row.chats_count) || 0,
    messages: Number(row.messages_count) || 0,
  };
  return {
    revision: Number(row.revision) || 0,
    initialized: (options.decodeInitialized ?? Boolean)(row.initialized),
    records: {
      ...records,
      total: Object.values(records).reduce((a, b) => a + b, 0),
    },
  };
}

/** Builds the `loadChatBranchGraph` response from branch and link rows. */
function buildChatBranchGraph(
  branchRows: readonly BranchRow[],
  graphRows: readonly Record<string, unknown>[],
) {
  const branches = branchRows.map(mapBranchRow);
  const messages = graphRows.map((row) => {
    const message = rebuildMessage(row);
    if (row.graph_generation_model != null) {
      message.generationInfo = { model: row.graph_generation_model };
    }
    return message;
  });
  const links = graphRows.map((row) => ({
    messageId: String(row.id),
    parentMessageId: row.parent_message_id ?? undefined,
    originBranchId: row.origin_branch_id,
  }));
  return {
    branches,
    activeBranchId: branchRows[0]?.active_branch_id ?? undefined,
    messages,
    links,
  };
}

/** `sha256` of a JSON payload, used as the cache key of every snapshot. */
function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Builds the `loadModuleRecords` snapshot, or `null` when there are none. */
function buildModuleRecordsSnapshot(
  modules: readonly { module_id: string; position: number | string }[],
  valueRows: readonly SettingValueRow[],
) {
  if (modules.length === 0) return null;
  const rebuilt: Record<string, unknown> = rebuildSettings(
    modules.map((row) => ({ key: row.module_id })),
    valueRows,
  );
  const result = modules.map((row) => ({
    ...decodePresetData(rebuilt[row.module_id]),
    id: row.module_id,
  }));
  return { modules: result, hash: sha256Json(result) };
}

/** Builds the `listBotPresets` listing (without the timing field). */
function buildBotPresetList(rows: readonly BotPresetListRow[]) {
  const presets = rows.map((row) => ({
    id: row.preset_id,
    position: Number(row.position),
    name: row.name || "",
    image: row.image || "",
    apiType: row.api_type || "",
    aiModel: row.ai_model || "",
    hash: row.content_hash,
  }));
  return { presets, hash: sha256Json(presets) };
}

/** Builds the `getTokenUsage` response. */
function mapTokenUsageRow(row: TokenUsageRow) {
  return {
    model: row.model,
    messageCount: Number(row.message_count) || 0,
    totalInputTokens: Number(row.total_input_tokens) || 0,
    totalOutputTokens: Number(row.total_output_tokens) || 0,
  };
}

/** Builds the `getAssetCatalogStats` response. */
function mapAssetCatalogStats(row: {
  total_objects?: number | string | null;
  total_size?: number | string | null;
}) {
  return {
    totalObjects: Number(row.total_objects) || 0,
    totalSizeBytes: Number(row.total_size) || 0,
  };
}

/**
 * Builds the character listing of `loadStartupData`.
 * Vendors hand back timestamps in different shapes, so the coercion is a
 * parameter; the payload itself is identical.
 */
function mapStartupCharacters(
  rows: readonly CharacterCoreRow[],
  toTimestamp: (value: unknown) => number | undefined,
) {
  return rows.map((row) => ({
    chaId: String(row.id),
    type: row.kind || "character",
    name: row.name || "",
    image: row.image || "",
    trashTime: toTimestamp(row.trash_time),
    creationDate: toTimestamp(row.creation_time),
    modificationDate: toTimestamp(row.modification_time),
    lastInteraction: toTimestamp(row.last_interaction_time),
    detailsLoaded: false,
    chats: [],
    chatPage: 0,
  }));
}

export {
  parseJsonSnapshot,
  parseRevisionListLimit,
  mapRevisionListRow,
  buildRevisionDetails,
  buildRevisionDiffTables,
  buildRestorePreview,
  mapBotChatStatsRow,
  mapRecentChatRow,
  summarizeStorageSyncRow,
  buildChatBranchGraph,
  sha256Json,
  buildModuleRecordsSnapshot,
  buildBotPresetList,
  mapTokenUsageRow,
  mapAssetCatalogStats,
  mapStartupCharacters,
};
