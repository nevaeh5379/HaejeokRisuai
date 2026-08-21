import type {
    DbVendor,
    NodeBackupConfig,
    NodeBackupProgressEvent,
    NodePostgresColumnInfo,
    NodePostgresRevision,
    NodePostgresServerConfig,
    NodePostgresTableData,
    NodePostgresTableInfo,
    NodePostgresTokenUsage
} from 'src/ts/storage/nodePostgresStorage'

export type DbExplorerTabType = 'tables' | 'config' | 'stats' | 'history'

export interface BotChatStats {
    id: string
    name: string
    avatarKey?: string
    image?: string
    isGroup: boolean
    totalSessions: number
    totalMessages: number
    userMessages: number
    botMessages: number
    longestSessionMessages: number
    lastActiveDate?: number | null
    avgBotMessageLen?: number
    avgUserMessageLen?: number
    avgMessagesPerSession?: number
}

export interface DbOverallStats {
    totalCharacters: number
    totalSessions: number
    totalMessages: number
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    totalModules: number
    totalLorebooks: number
    totalTables: number
    totalRows: number
}

export type BotStatsSortType = 'messages_desc' | 'sessions_desc' | 'recent_desc' | 'name_asc'
export type ModelStatsSortType = 'tokens_desc' | 'requests_desc' | 'name_asc'
export type HistoryScopeFilter = 'all' | 'database' | 'cold-storage' | 'restore'

