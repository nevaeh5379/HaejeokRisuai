import type { ISqlStorage } from './ISqlStorage'
import { isTauri, isNodeServer } from '../platform'

let storageSingleton: ISqlStorage | null = null

/**
 * Returns the appropriate SQL storage backend for the current environment.
 *
 * - Node server: NodePostgresStorage (external PostgreSQL/Oracle/Azure)
 * - Tauri desktop: TauriSqliteStorage (local SQLite via tauri-plugin-sql)
 * - Web browser: WebSqliteStorage (SQLite WASM with OPFS)
 *
 * The instance is cached for the lifetime of the page.
 */
export async function getSqlStorage(): Promise<ISqlStorage> {
    if (storageSingleton) {
        return storageSingleton
    }

    if (isNodeServer) {
        // Node server uses NodePostgresStorage via NodeStorage
        const { forageStorage } = await import('../globalApi.svelte')
        const { NodeStorage } = await import('./nodeStorage')
        if (forageStorage.realStorage instanceof NodeStorage) {
            storageSingleton = forageStorage.realStorage.postgres as unknown as ISqlStorage
            return storageSingleton
        }
        // Fallback: create a standalone NodePostgresStorage
        const { NodePostgresStorage } = await import('./nodePostgresStorage')
        storageSingleton = new NodePostgresStorage(async () => '') as unknown as ISqlStorage
        return storageSingleton
    }

    if (isTauri) {
        const { TauriSqliteStorage } = await import('./tauriSqliteStorage')
        storageSingleton = new TauriSqliteStorage()
        return storageSingleton
    }

    // Web browser
    const { WebSqliteStorage } = await import('./webSqliteStorage')
    storageSingleton = new WebSqliteStorage()
    return storageSingleton
}

/**
 * Reset the cached storage instance (used when switching backends, e.g.
 * after configuring SQL on the Node server).
 */
export function resetSqlStorage(): void {
    storageSingleton = null
}