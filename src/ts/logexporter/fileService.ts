import { downloadFile } from 'src/ts/globalApi.svelte'
import { alertError } from 'src/ts/alert'

/**
 * File & clipboard services for the Log Exporter.
 * Uses RisuAI's native download pipeline instead of the plugin's
 * anchor-click workaround.
 */

export const MIME_TYPES = {
    HTML: 'text/html;charset=utf-8',
    PLAIN_TEXT: 'text/plain;charset=utf-8',
    JSON: 'application/json;charset=utf-8',
    PNG: 'image/png',
    JPEG: 'image/jpeg',
    WEBP: 'image/webp',
} as const

export function sanitizeFilename(name: string, replacement = '-'): string {
    return name.replace(/[/\\?%*:|"<>]/g, replacement)
}

/** Saves a string or Blob as a downloadable file. */
export async function saveAsFile(
    filename: string,
    content: string | Blob,
): Promise<void> {
    try {
        if (content instanceof Blob) {
            await downloadFile(filename, await content.arrayBuffer())
        } else {
            await downloadFile(filename, content)
        }
    } catch (err) {
        console.error(`[logexporter] File save failed (${filename}):`, err)
        alertError(`파일 저장에 실패했습니다: ${filename}`)
    }
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
    await saveAsFile(filename, blob)
}

// ─── Clipboard ───────────────────────────────────────────────────────────────

export interface ClipboardCopyOptions {
    notify?: boolean
    plainTextFallback?: string
}

function isClipboardApiSupported(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        Boolean(navigator.clipboard?.write) &&
        typeof window !== 'undefined' &&
        typeof window.ClipboardItem !== 'undefined'
    )
}

async function copyViaClipboardApi(htmlText: string, plainText?: string): Promise<boolean> {
    try {
        const htmlBlob = new Blob([htmlText], { type: 'text/html' })
        const textBlob = new Blob([plainText ?? htmlText], { type: 'text/plain' })
        await navigator.clipboard.write([
            new ClipboardItem({
                'text/html': htmlBlob,
                'text/plain': textBlob,
            }),
        ])
        return true
    } catch (err) {
        console.warn('[logexporter] Async clipboard copy failed:', err)
        return false
    }
}

function copyViaDomFallback(htmlText: string): boolean {
    if (typeof document === 'undefined') return false
    const container = document.createElement('div')
    container.innerHTML = htmlText
    container.style.position = 'fixed'
    container.style.left = '-9999px'
    container.style.opacity = '0'
    let successful = false
    try {
        document.body.appendChild(container)
        const range = document.createRange()
        range.selectNodeContents(container)
        const selection = window.getSelection()
        if (selection) {
            selection.removeAllRanges()
            selection.addRange(range)
            successful = document.execCommand('copy')
            selection.removeAllRanges()
        }
    } catch {
        successful = false
    } finally {
        container.parentNode?.removeChild(container)
    }
    return successful
}

/** Copies rich HTML to the clipboard with a plain-text fallback. */
export async function copyToClipboard(text: string, options: ClipboardCopyOptions = {}): Promise<boolean> {
    if (isClipboardApiSupported()) {
        if (await copyViaClipboardApi(text, options.plainTextFallback)) {
            return true
        }
    }
    if (copyViaDomFallback(text)) {
        return true
    }
    console.error('[logexporter] All clipboard copy methods failed')
    return false
}
