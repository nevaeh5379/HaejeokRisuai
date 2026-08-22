import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    class NodeStorage {
        getItems = vi.fn(async (_keys: string[]) => {
            throw new Error('bulk unavailable')
        })
        getDirectUrl = vi.fn(async () => '/api/read')
    }
    const storage = new NodeStorage()
    return {
        NodeStorage,
        storage,
        forageStorage: { realStorage: storage },
        getFileSrc: vi.fn(async () => '/api/read'),
    }
})

vi.mock(import('./storage/nodeStorage'), () => ({
    NodeStorage: mocks.NodeStorage,
}) as any)

vi.mock(import('./globalApi.svelte'), () => ({
    forageStorage: mocks.forageStorage,
    getFileSrc: mocks.getFileSrc,
}) as any)

vi.mock(import('./stores/domain/settingsStore.svelte'), () => ({
    settingsStore: { state: { hideAllImages: false } },
}) as any)

vi.mock(import('./media/mimeType'), () => ({
    getMimeType: () => 'image/png',
}))

import { fullImageBlobCache, getCharImagesBatch, preloadCharacterImage } from './characterImage'

describe('getCharImagesBatch', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        fullImageBlobCache.clear()
    })

    it('never falls back to one direct request per local image', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const locations = Array.from({ length: 50 }, (_, index) => `assets/image-${index}.png`)

        const result = await getCharImagesBatch(locations, { size: 'display' })

        expect(mocks.storage.getItems).toHaveBeenCalledTimes(3)
        expect(mocks.storage.getItems.mock.calls.map((call) => call[0].length)).toEqual([24, 24, 2])
        expect(mocks.storage.getDirectUrl).not.toHaveBeenCalled()
        expect(mocks.getFileSrc).not.toHaveBeenCalled()
        expect([...result.values()]).toEqual(Array(50).fill('/none.webp'))
        consoleError.mockRestore()
    })
})

describe('preloadCharacterImage', () => {
    it('starts one reusable browser image request for concurrent calls', async () => {
        const requestedSources: string[] = []
        let imageCount = 0
        class MockImage {
            decoding = ''
            fetchPriority = ''
            complete = false
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            constructor() {
                imageCount += 1
            }

            set src(value: string) {
                requestedSources.push(value)
                queueMicrotask(() => this.onload?.())
            }
        }
        vi.stubGlobal('Image', MockImage)
        mocks.getFileSrc.mockResolvedValueOnce('/api/read?avatar=1')

        const first = preloadCharacterImage('assets/chat-avatar.png')
        const second = preloadCharacterImage('assets/chat-avatar.png')

        expect(first).toBe(second)
        await first
        expect(mocks.getFileSrc).toHaveBeenCalledWith('assets/chat-avatar.png', undefined)
        expect(requestedSources).toEqual(['/api/read?avatar=1'])
        expect(imageCount).toBe(1)
        vi.unstubAllGlobals()
    })
})
