import type { SqlCommit } from './sqlCommit'

export type SqliteExecute = (sql: string, bind?: unknown[]) => void | Promise<void>

export async function applySqliteCommit(commit: SqlCommit, execute: SqliteExecute): Promise<void> {
    for (const upsert of commit.root.upserts) {
        await execute("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))", [upsert.key, JSON.stringify(upsert.value)])
    }
    for (const key of commit.root.deletes) {
        await execute('DELETE FROM system_settings WHERE key = ?', [key])
    }

    for (const entry of commit.characters) {
        const data = entry.data as Record<string, unknown>
        await execute(`INSERT OR REPLACE INTO characters
            (id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded, data, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))`, [
            entry.id, entry.position, data.type ?? 'character', data.name ?? '', data.image ?? null,
            data.trashTime ?? null, data.creationDate ?? null, data.modificationDate ?? null,
            data.lastInteraction ?? null, JSON.stringify(data),
        ])
    }
    if (commit.characterIds !== undefined) {
        if (commit.characterIds.length === 0) {
            await execute('DELETE FROM characters')
        } else {
            const placeholders = commit.characterIds.map(() => '?').join(',')
            await execute(`DELETE FROM characters WHERE id NOT IN (${placeholders})`, commit.characterIds)
        }
    }

    for (const entry of commit.chats) {
        const data = entry.data as Record<string, unknown>
        await execute(`INSERT OR REPLACE INTO chats
            (id, character_id, position, name, note, folder_id, last_message_time, messages_loaded, data, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`, [
            entry.id, entry.characterId, entry.position, data.name ?? '', data.note ?? '',
            data.folderId ?? null, data.lastDate ?? null, JSON.stringify(data),
        ])
    }
    for (const manifest of commit.chatManifests) {
        if (manifest.ids.length === 0) {
            await execute('DELETE FROM chats WHERE character_id = ?', [manifest.characterId])
        } else {
            const placeholders = manifest.ids.map(() => '?').join(',')
            await execute(`DELETE FROM chats WHERE character_id = ? AND id NOT IN (${placeholders})`, [manifest.characterId, ...manifest.ids])
        }
    }

    for (const entry of commit.messages) {
        const data = entry.data as Record<string, unknown>
        await execute('INSERT OR REPLACE INTO messages (chat_id, id, position, role, sent_time, data) VALUES (?, ?, ?, ?, ?, ?)', [
            entry.chatId, entry.id, entry.position, data.role ?? 'char', data.time ?? null, JSON.stringify(data),
        ])
    }
    for (const manifest of commit.messageManifests) {
        if (manifest.ids.length === 0) {
            await execute('DELETE FROM messages WHERE chat_id = ?', [manifest.chatId])
        } else {
            const placeholders = manifest.ids.map(() => '?').join(',')
            await execute(`DELETE FROM messages WHERE chat_id = ? AND id NOT IN (${placeholders})`, [manifest.chatId, ...manifest.ids])
        }
    }
}
