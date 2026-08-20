export interface NavigatorMemoryHints {
    deviceMemory?: number
    userAgent?: string
}

/**
 * Browser memory hints are intentionally coarse and are absent in Firefox.
 * Treat mobile browsers without the hint as constrained as well: their image
 * decoder and WebView limits are usually much tighter than desktop limits.
 */
export function isMemoryConstrainedDevice(hints?: NavigatorMemoryHints): boolean {
    const source = hints ?? (typeof navigator === 'undefined' ? undefined : navigator as Navigator & NavigatorMemoryHints)
    if (!source) return false

    const deviceMemory = Number(source.deviceMemory)
    if (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4) return true
    return /Android|iPhone|iPad|iPod|Mobile/i.test(source.userAgent ?? '')
}
