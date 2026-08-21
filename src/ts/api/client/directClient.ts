import { forageStorage } from '../../globalApi.svelte'
import { NodeStorage } from '../../storage/nodeStorage'
import type { botPreset, Message } from '../../storage/database.svelte'
import type { RisuModule } from '../../process/modules'

async function getAuthHeaders(): Promise<Record<string, string>> {
    if (forageStorage.realStorage instanceof NodeStorage) {
        const token = await forageStorage.realStorage.getCachedAuth()
        return token ? { authorization: `Bearer ${token}` } : {}
    }
    return {}
}

export async function directUpdateSetting(key: string, value: unknown): Promise<void> {
    try {
        const headers = await getAuthHeaders()
        await fetch(`/api/db/settings/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: {
                'content-type': 'application/json',
                ...headers,
            },
            body: JSON.stringify({ value }),
        })
    } catch (error) {
        console.error(`Failed to direct update setting ${key}:`, error)
    }
}

export async function directDeleteSetting(key: string): Promise<void> {
    try {
        const headers = await getAuthHeaders()
        await fetch(`/api/db/settings/${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers,
        })
    } catch (error) {
        console.error(`Failed to direct delete setting ${key}:`, error)
    }
}

export async function directSaveBotPreset(preset: botPreset, position = 0): Promise<void> {
    try {
        const headers = await getAuthHeaders()
        await fetch('/api/db/bot-presets', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...headers,
            },
            body: JSON.stringify({ preset, position }),
        })
    } catch (error) {
        console.error('Failed to direct save bot preset:', error)
    }
}

export async function directSaveModule(moduleData: RisuModule): Promise<void> {
    try {
        const headers = await getAuthHeaders()
        await fetch('/api/db/modules', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...headers,
            },
            body: JSON.stringify({ module: moduleData }),
        })
    } catch (error) {
        console.error(`Failed to direct save module ${moduleData.id}:`, error)
    }
}

export async function directDeleteModule(moduleId: string): Promise<void> {
    try {
        const headers = await getAuthHeaders()
        await fetch(`/api/db/modules/${encodeURIComponent(moduleId)}`, {
            method: 'DELETE',
            headers,
        })
    } catch (error) {
        console.error(`Failed to direct delete module ${moduleId}:`, error)
    }
}

export async function directSaveMessage(chatId: string, message: Message): Promise<void> {
    try {
        const headers = await getAuthHeaders()
        await fetch(`/api/db/chats/${encodeURIComponent(chatId)}/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...headers,
            },
            body: JSON.stringify({ message }),
        })
    } catch (error) {
        console.error(`Failed to direct save message in chat ${chatId}:`, error)
    }
}

export async function directDeleteMessage(chatId: string, messageId: string): Promise<void> {
    try {
        const headers = await getAuthHeaders()
        await fetch(`/api/db/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
            method: 'DELETE',
            headers,
        })
    } catch (error) {
        console.error(`Failed to direct delete message ${messageId} in chat ${chatId}:`, error)
    }
}
