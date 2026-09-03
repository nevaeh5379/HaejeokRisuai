import type { DbVendor } from "./storageConfig.cjs";

export interface NodePostgresRevision {
  id: number;
  storage_revision: number | null;
  database_initialized: boolean | null;
  scope: "database" | "cold-storage" | "restore";
  action: string;
  restored_from_revision: number | null;
  created_at: string;
  change_count: number;
}

export interface NodePostgresAuditLogItem {
  sequence: number;
  revisionId?: number;
  tableName: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  beforeRow: Record<string, unknown> | null;
  afterRow: Record<string, unknown> | null;
  recordedAt: string;
}

export interface NodePostgresTableSummary {
  tableName: string;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
  totalCount: number;
}

export interface NodePostgresRevisionDetails extends NodePostgresRevision {
  tableSummaries: NodePostgresTableSummary[];
  auditLogs: NodePostgresAuditLogItem[];
}

export interface NodePostgresRevisionDiff {
  baseRevisionId: number;
  targetRevisionId: number;
  totalChanges: number;
  tables: Array<
    NodePostgresTableSummary & { entries: NodePostgresAuditLogItem[] }
  >;
}

export interface NodePostgresRestorePreview {
  targetRevisionId: number;
  currentRevisionId: number;
  revisionsToRevert: number;
  totalOperations: number;
  restoreInsertCount: number;
  restoreDeleteCount: number;
  restoreUpdateCount: number;
  affectedTables: Array<{
    tableName: string;
    revertedInserts: number;
    revertedUpdates: number;
    revertedDeletes: number;
    totalChanges: number;
  }>;
}

export interface NodePostgresMessageSearchResult {
  storageState: "active" | "cold";
  archiveId: string | null;
  characterId: string | null;
  characterName: string | null;
  chatId: string | null;
  chatName: string;
  messageId: string;
  position: number;
  role: "user" | "char";
  sentTime: number | null;
  senderName: string | null;
  snippet: string;
}

export interface NodePostgresTokenUsage {
  model: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface NodePostgresBotChatStats {
  id: string;
  name: string;
  avatarKey?: string;
  image?: string;
  isGroup: boolean;
  totalSessions: number;
  totalMessages: number;
  userMessages: number;
  botMessages: number;
  longestSessionMessages: number;
  lastActiveDate?: number | null;
  avgBotMessageLen?: number;
  avgUserMessageLen?: number;
  avgMessagesPerSession?: number;
}

export interface NodePostgresCharacterSearchResult {
  id: string;
  name: string;
  image: string | null;
  kind: "character" | "group";
}

export interface NodePostgresTableInfo {
  name: string;
  rowCount: number;
}

export interface NodePostgresColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface NodePostgresTableData {
  table: string;
  columns: NodePostgresColumnInfo[];
  allColumns?: NodePostgresColumnInfo[];
  rows: Record<string, unknown>[];
  offset: number;
  limit: number;
  total: number;
}

export interface NodeBackupMirroringConfig {
  enabled: boolean;
}

export interface NodeBackupSnapshotConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface NodeBackupConfig {
  configured: boolean;
  enabled: boolean;
  vendor: DbVendor | null;
  managedByEnvironment: boolean;
  mirroring: NodeBackupMirroringConfig;
  snapshot: NodeBackupSnapshotConfig;
  params: Record<string, any>;
  primaryRevision: number | null;
  backupRevision: number | null;
  lag: number | null;
  backupInitialized: boolean;
  inFlight: boolean;
  lastMirrorAt: string | null;
  lastMirrorError: string | null;
  lastSnapshotAt: string | null;
  lastSnapshotError: string | null;
  lastFullSyncAt: string | null;
  lastFullSyncError: string | null;
}

export interface NodeBackupConfigUpdate {
  vendor: DbVendor;
  params: Record<string, any>;
  mirroring: NodeBackupMirroringConfig;
  snapshot: NodeBackupSnapshotConfig;
}

export interface NodeBackupProgressEvent {
  type?: "progress" | "done" | "error";
  stage?:
    | "reading"
    | "preparing"
    | "connecting"
    | "settings"
    | "characters"
    | "chats"
    | "messages"
    | "finalizing"
    | "done"
    | string;
  message?: string;
  percentage?: number;
  current?: number;
  total?: number;
  settingsCount?: number;
  charactersCount?: number;
  chatsCount?: number;
  messagesCount?: number;
  lastFullSyncAt?: string;
  error?: string;
  [key: string]: unknown;
}

export interface NodeBackupFullSyncResult {
  success: boolean;
  lastFullSyncAt?: string;
  settingsCount?: number;
  charactersCount?: number;
  chatsCount?: number;
  messagesCount?: number;
  revision?: number;
  changed?: {
    root?: number;
    characters?: number;
    chats?: number;
    messages?: number;
  };
}
