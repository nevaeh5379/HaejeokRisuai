import type { Database } from './database.svelte'
import type { ISqlStorage } from './ISqlStorage'

/**
 * Legacy DataSession stub for backwards compatibility during migration.
 * Active state synchronization is now handled by Domain Stores.
 */
export class DataSession {
    constructor(_database: Database, _storage: ISqlStorage) {}
    dispose(): void {}
    async flush(): Promise<void> {}
    async transaction<T>(operation: (session: DataSession) => T | Promise<T>): Promise<T> {
        return await operation(this)
    }
}

export function startDataSession(database: Database, storage: ISqlStorage): DataSession {
    return new DataSession(database, storage)
}

export function getDataSession(): DataSession {
    return new DataSession({} as any, {} as any)
}

export function replaceActiveDataSession(_database: Database): Promise<void> {
    return Promise.resolve()
}

export async function flushDataSession(): Promise<void> {}
export function releaseInactiveChatMessages(_activeChatId?: string): void {}
export function compactChatMessages(_chatId: string): void {}
export function cancelChatMessageCompaction(_chatId: string): void {}
