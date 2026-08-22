import type { SqlCommit } from './sqlCommit'

export type SqliteExecute = (sql: string, bind?: unknown[]) => void | Promise<void>

export async function applySqliteCommit(commit: SqlCommit, execute: SqliteExecute): Promise<void> {
    if (commit.replaceAll) {
        await execute('DELETE FROM plugin_custom_storage')
    }

    for (const upsert of commit.root.upserts) {
        await execute("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))", [upsert.key, JSON.stringify(upsert.value)])
        if (upsert.key === 'pluginCustomStorage') {
            if (upsert.value && typeof upsert.value === 'object') {
                const entries = Object.entries(upsert.value)
                if (entries.length === 0) {
                    await execute('DELETE FROM plugin_custom_storage')
                } else {
                    const keys = entries.map(([k]) => k)
                    const placeholders = keys.map(() => '?').join(',')
                    await execute(`DELETE FROM plugin_custom_storage WHERE key NOT IN (${placeholders})`, keys)
                    for (const [pluginKey, pluginVal] of entries) {
                        await execute(
                            "INSERT OR REPLACE INTO plugin_custom_storage (key, value, updated_at) VALUES (?, ?, datetime('now'))",
                            [pluginKey, JSON.stringify(pluginVal)],
                        )
                    }
                }
            } else {
                await execute('DELETE FROM plugin_custom_storage')
            }
        }
    }
    for (const key of commit.root.deletes) {
        await execute('DELETE FROM system_settings WHERE key = ?', [key])
        if (key === 'pluginCustomStorage') {
            await execute('DELETE FROM plugin_custom_storage')
        }
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
    if (commit.messageDeletes) {
        for (const del of commit.messageDeletes) {
            if (del.ids.length > 0) {
                const placeholders = del.ids.map(() => '?').join(',')
                await execute(`DELETE FROM messages WHERE chat_id = ? AND id IN (${placeholders})`, [del.chatId, ...del.ids])
            }
        }
    }
}
