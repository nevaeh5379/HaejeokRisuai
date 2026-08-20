import { describe, expect, it } from 'vitest'
import { isMemoryConstrainedDevice } from './deviceMemory'

describe('isMemoryConstrainedDevice', () => {
    it('uses the browser memory hint when available', () => {
        expect(isMemoryConstrainedDevice({ deviceMemory: 4, userAgent: 'Desktop' })).toBe(true)
        expect(isMemoryConstrainedDevice({ deviceMemory: 8, userAgent: 'Desktop' })).toBe(false)
    })

    it('treats mobile browsers without a memory hint as constrained', () => {
        expect(isMemoryConstrainedDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 8.0)' })).toBe(true)
        expect(isMemoryConstrainedDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false)
    })
})
