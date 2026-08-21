import { DBState } from './stores.svelte'
import { forageStorage, getFileSrc } from './globalApi.svelte'
import { NodeStorage } from './storage/nodeStorage'
import { getMimeType } from './media/mimeType'

// Global cache for character images across the application session
export const fullImageBlobCache = new Map<string, string>()

export async function getCharImage(
    loc: string,
    type: 'plain' | 'css' | 'contain' | 'lgcss',
    options?: { thumbnail?: boolean },
) {
    if (DBState.db.hideAllImages) return type === 'plain' ? '/none.webp' : ''
    if (!loc) return type === 'css' ? '' : null

    if (!options?.thumbnail && fullImageBlobCache.has(loc)) {
        const fileSource = fullImageBlobCache.get(loc)!
        if (type === 'plain') return fileSource
        if (type === 'css') return `background: url("${fileSource}");background-size: cover;`
        if (type === 'lgcss') return `background: url("${fileSource}");background-size: cover;height: 10.66rem;`
        return `background: url("${fileSource}");background-size: contain;background-repeat: no-repeat;background-position: center;`
    }

    const fileSource = await getFileSrc(loc, options)
    if (!options?.thumbnail && fileSource) {
        fullImageBlobCache.set(loc, fileSource)
    }
    if (type === 'plain') return fileSource
    if (type === 'css') return `background: url("${fileSource}");background-size: cover;`
    if (type === 'lgcss') return `background: url("${fileSource}");background-size: cover;height: 10.66rem;`
    return `background: url("${fileSource}");background-size: contain;background-repeat: no-repeat;background-position: center;`
}

export interface CharImageOptions {
    size?: 'display' | 'thumb' | 'full'
    thumbnail?: boolean
    width?: number
    height?: number
}

export async function getCharImagesBatch(
    locs: string[],
    options: CharImageOptions = { size: 'display' }
): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (!locs || locs.length === 0) return result
    if (DBState.db.hideAllImages) {
        for (const loc of locs) {
            result.set(loc, '/none.webp')
        }
        return result
    }

    const sizeKey = options.size ?? (options.thumbnail ? 'thumb' : 'full')
    const uncachedLocs: string[] = []
    for (const loc of locs) {
        if (!loc) continue
        const cacheKey = `${sizeKey}_${loc}`
        if (fullImageBlobCache.has(cacheKey)) {
            result.set(loc, fullImageBlobCache.get(cacheKey)!)
        } else {
            uncachedLocs.push(loc)
        }
    }

    if (uncachedLocs.length === 0) {
        return result
    }

    // NodeStorage: fetch all in 1 single POST /api/read-bulk request
    if (forageStorage.realStorage instanceof NodeStorage) {
        const nodeStorage = forageStorage.realStorage as NodeStorage
        try {
            const assetLocs = uncachedLocs.filter(loc => loc.startsWith('assets'))
            const nonAssetLocs = uncachedLocs.filter(loc => !loc.startsWith('assets'))

            if (assetLocs.length > 0) {
                const bulkOpts = {
                    size: options.size,
                    thumbnail: options.thumbnail,
                    width: options.width ?? (options.size === 'display' ? 512 : (options.thumbnail ? 128 : undefined)),
                    height: options.height ?? (options.size === 'display' ? 768 : (options.thumbnail ? 128 : undefined))
                }
                const itemsMap = await nodeStorage.getItems(assetLocs, undefined, bulkOpts)
                for (const loc of assetLocs) {
                    const buf = itemsMap.get(loc)
                    const cacheKey = `${sizeKey}_${loc}`
                    if (buf && buf.length > 0) {
                        const mime = (options.size === 'display' || options.thumbnail) ? 'image/webp' : getMimeType(loc)
                        const blob = new Blob([buf as any], { type: mime })
                        const blobUrl = URL.createObjectURL(blob)
                        fullImageBlobCache.set(cacheKey, blobUrl)
                        result.set(loc, blobUrl)
                    } else {
                        // Fallback to direct url if buffer was missing
                        const fallbackUrl = await nodeStorage.getDirectUrl(loc, bulkOpts)
                        fullImageBlobCache.set(cacheKey, fallbackUrl)
                        result.set(loc, fallbackUrl)
                    }
                }
            }

            for (const loc of nonAssetLocs) {
                const src = await getFileSrc(loc, options)
                const cacheKey = `${sizeKey}_${loc}`
                if (src) {
                    fullImageBlobCache.set(cacheKey, src)
                    result.set(loc, src)
                }
            }
            return result
        } catch (e) {
            console.error('Failed to batch load character images, falling back', e)
        }
    }

    // Fallback for Tauri, Web, OPFS, etc.: load in parallel
    await Promise.all(
        uncachedLocs.map(async (loc) => {
            try {
                const src = await getFileSrc(loc, options)
                const cacheKey = `${sizeKey}_${loc}`
                if (src) {
                    fullImageBlobCache.set(cacheKey, src)
                    result.set(loc, src)
                }
            } catch (err) {
                console.error(err)
            }
        })
    )

    return result
}

