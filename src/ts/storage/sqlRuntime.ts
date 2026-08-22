import type { ISqlStorage } from './ISqlStorage'

let storage: ISqlStorage | null = null

export function setSqlRuntime(next: ISqlStorage): void { storage = next }
export function getSqlRuntime(): { isSql: boolean; storage: ISqlStorage | null } {
    return { isSql: storage !== null, storage }
}
