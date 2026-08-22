// Keep the default DOM deliberately small: every rendered message owns a
// Svelte component, parsed HTML, event handlers, and potentially decoded media.
// Users can still raise these values in Display settings when memory is ample.
import { isMemoryConstrainedDevice } from './memory/deviceMemory'

export const DEFAULT_CHAT_LOAD_INITIAL_PAGES = isMemoryConstrainedDevice() ? 8 : 12
export const DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES = isMemoryConstrainedDevice() ? 6 : 8

export function normalizeChatLoadPages(value: unknown, fallback: number): number {
    const fallbackValue = Number.isFinite(fallback) && fallback >= 1
        ? Math.floor(fallback)
        : 1
    const numberValue = typeof value === 'number' ? value : Number(value)

    if (!Number.isFinite(numberValue) || numberValue < 1) {
        return fallbackValue
    }

    return Math.floor(numberValue)
}

export function getInitialChatLoadPages(db: { chatLoadInitialPages?: number }): number {
    return normalizeChatLoadPages(db.chatLoadInitialPages, DEFAULT_CHAT_LOAD_INITIAL_PAGES)
}

export function getAdditionalChatLoadPages(db: { chatLoadAdditionalPages?: number }): number {
    return normalizeChatLoadPages(db.chatLoadAdditionalPages, DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES)
}
