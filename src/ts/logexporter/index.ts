import { logExporterStore } from './store.svelte'
import type { MessageRangeOptions } from './types'

/**
 * Log Exporter public API.
 *
 * Native port of the risu-log-plugin entry points:
 * - `openLogExporter()`          → full chat export
 * - `openLogExporterFrom(index)` → export from a message onward
 * - `openLogExporterSingle(index)` → export one message only
 */

export function openLogExporter(options: MessageRangeOptions = {}): void {
    logExporterStore.open(options)
}

export function openLogExporterFrom(messageIndex: number): void {
    logExporterStore.open({ startIndex: messageIndex })
}

export function openLogExporterSingle(messageIndex: number): void {
    logExporterStore.open({ singleMessage: messageIndex })
}

export { logExporterStore }
export * from './types'
export { THEMES, COLORS, resolveEffectiveColor } from './constants'
