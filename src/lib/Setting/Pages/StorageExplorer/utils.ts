import { forageStorage } from 'src/ts/globalApi.svelte'
import { NodeStorage } from 'src/ts/storage/nodeStorage'
import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte'
import { characterStore } from 'src/ts/stores/domain/characterStore.svelte'
import { language } from 'src/lang'
import type {
    BotAssetItem,
    BotStorageInfo,
    FileSortType,
    ModuleStorageInfo,
    NodeStorageAssetItem,
    NodeStorageAssetDetails,
    ViewTarget
} from './types'

export function sortAssetFiles(files: NodeStorageAssetItem[], sortType: FileSortType): NodeStorageAssetItem[] {
    const list = [...files]
    switch (sortType) {
        case 'size_desc':
            return list.sort((a, b) => b.size - a.size)
        case 'size_asc':
            return list.sort((a, b) => a.size - b.size)
        case 'name_asc':
            return list.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }))
        case 'name_desc':
            return list.sort((a, b) => b.key.localeCompare(a.key, undefined, { numeric: true, sensitivity: 'base' }))
        default:
            return list
    }
}

export function isThumbnailKey(key: string): boolean {
    return typeof key === 'string' && key.startsWith('thumbnails/')
}

export function extractOriginalKeyFromThumbnail(thumbnailKey: string): string | null {
    if (!thumbnailKey || typeof thumbnailKey !== 'string' || !thumbnailKey.startsWith('thumbnails/')) {
        return null
    }
    const match = thumbnailKey.match(/^thumbnails\/(.+)_\d+x\d+\.webp$/i)
    if (match) {
        return match[1]
    }
    return thumbnailKey.replace(/^thumbnails\//, '')
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function getNodeStorage(): NodeStorage {
    if (!(forageStorage.realStorage instanceof NodeStorage)) {
        throw new Error('Node storage is not available')
    }
    return forageStorage.realStorage
}

export function generateKeyCandidates(key: string): string[] {
    if (!key || typeof key !== 'string') return []
    const stripped = key.replace(/^assets\//, '')
    const candidates: string[] = []
    const pushCandidate = (candidate: string) => {
        if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
    }
    pushCandidate(key)
    pushCandidate(`assets/${stripped}`)
    if (stripped !== key) pushCandidate(stripped)
    return candidates
}

export async function readImageFromTarget(key: string, viewTarget: ViewTarget): Promise<Uint8Array | null> {
    const storage = getNodeStorage()
    const data = await storage.getItem(key, { target: viewTarget })
    return data
}

export function isImageFile(key: string): boolean {
    return /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(key)
}

export function isAudioFile(key: string): boolean {
    return /\.(mp3|wav|ogg|flac|aac|m4a|webm)$/i.test(key)
}

export interface AnalysisResult {
    bots: BotStorageInfo[]
    modules: ModuleStorageInfo[]
    orphanAssets: NodeStorageAssetItem[]
    orphanSizeBytes: number
    totalMissingAssets: number
}

export async function runStorageAnalysis(
    assetMap: Map<string, NodeStorageAssetItem>,
    assetDetails: NodeStorageAssetDetails | null
): Promise<AnalysisResult> {
    const characters = characterStore.characters || []

    // SQL storage lazy-loads characters with only core fields
    const adapter = settingsStore.state as any
    if (adapter?.ensureCharacterDetails) {
        await Promise.allSettled(
            characters
                .filter((c: any) => c && c.detailsLoaded === false && c.chaId)
                .map((c: any) => adapter.ensureCharacterDetails(c.chaId))
        )
    }

    const referencedKeys = new Set<string>()
    const bots: BotStorageInfo[] = []

    function resolveAsset(key: string | undefined) {
        if (!key || typeof key !== 'string') return
        const candidates = generateKeyCandidates(key)

        let item: NodeStorageAssetItem | undefined
        let matchedKey = key
        for (const candidate of candidates) {
            const found = assetMap.get(candidate)
            if (found) {
                item = found
                matchedKey = candidate
                break
            }
        }
        for (const candidate of candidates) referencedKeys.add(candidate)
        return { matchedKey, size: item?.size ?? 0, exists: !!item }
    }

    for (const char of characters) {
        if (!char) continue
        const botAssets: BotAssetItem[] = []
        const seenKeys = new Set<string>()
        let avatarKey: string | undefined

        function addAsset(key: string | undefined, type: BotAssetItem['type'], label: string): string | undefined {
            const resolved = resolveAsset(key)
            if (!resolved) return
            const { matchedKey, size, exists } = resolved

            if (!seenKeys.has(matchedKey)) {
                seenKeys.add(matchedKey)
                botAssets.push({ key: matchedKey, type, label, size, missing: !exists })
            }
            return matchedKey
        }

        // Main avatar
        if (char.image) {
            avatarKey = addAsset(char.image, 'avatar', 'Main Avatar')
        }

        // Emotion sprites
        let emotionsCount = 0
        const emoList = (char as any).emotionImages || (char as any).emotions
        if (Array.isArray(emoList)) {
            for (const emo of emoList) {
                if (Array.isArray(emo) && emo[1]) {
                    addAsset(emo[1], 'emotion', emo[0] || 'Emotion')
                    emotionsCount++
                }
            }
        }

        // Additional assets
        let additionalCount = 0
        const addAssets = (char as any).additionalAssets
        if (Array.isArray(addAssets)) {
            for (const add of addAssets) {
                if (Array.isArray(add) && add[1]) {
                    addAsset(add[1], 'additional', add[2] || add[0] || 'Extra Asset')
                    additionalCount++
                }
            }
        }

        // Character Card Assets (charx)
        let ccAssetsCount = 0
        const ccAssetsList = (char as any).ccAssets
        if (Array.isArray(ccAssetsList)) {
            for (const cca of ccAssetsList) {
                if (cca?.uri) {
                    addAsset(cca.uri, 'ccAsset', cca.name || cca.type || 'CC Asset')
                    ccAssetsCount++
                }
            }
        }

        // Custom Background
        const customBg = (char as any).customBackground
        if (customBg) {
            addAsset(customBg, 'background', language.storageBackground || 'Background')
        }

        // Audio / TTS
        let audioCount = 0
        const sovits = (char as any).gptSoVitsConfig
        if (sovits?.ref_audio_data?.assetId) {
            addAsset(sovits.ref_audio_data.assetId, 'audio', 'GPT-SoVITS Audio')
            audioCount++
        }

        if ((char as any).vits?.files) {
            const vitsFiles = (char as any).vits.files
            for (const key of Object.keys(vitsFiles)) {
                const vitAsset = vitsFiles[key]
                if (vitAsset) {
                    addAsset(vitAsset, 'audio', `VITS: ${key}`)
                    audioCount++
                }
            }
        }

        const totalSize = botAssets.reduce((sum, a) => sum + a.size, 0)
        const missingCount = botAssets.filter((a) => a.missing).length

        bots.push({
            id: (char as any).id || (char as any).chaId || char.name,
            name: char.name || 'Unnamed Bot',
            avatarKey: avatarKey || char.image,
            totalAssets: botAssets.length,
            totalSizeBytes: totalSize,
            assets: botAssets,
            emotionsCount,
            additionalAssetsCount: additionalCount,
            ccAssetsCount,
            audioCount,
            missingAssetsCount: missingCount
        })
    }

    const modules: ModuleStorageInfo[] = []
    const moduleEntries = (settingsStore.state.modules || []).map((module: any, index: number) => ({
        module,
        storageId: module.id || `module:${index}`,
        displayName: module.name
    }))
    for (const [index, persona] of (settingsStore.state.personas || []).entries()) {
        if (!persona?.embeddedModule) continue
        moduleEntries.push({
            module: persona.embeddedModule,
            storageId: `persona:${persona.id || index}:embedded`,
            displayName: `${persona.embeddedModule.name || persona.name} (${language.storageEmbeddedModule})`
        })
    }

    for (const { module, storageId, displayName } of moduleEntries) {
        if (!module) continue
        const moduleAssets: BotAssetItem[] = []
        const seenKeys = new Set<string>()

        const addModuleAsset = (key: string | undefined, type: BotAssetItem['type'], label: string) => {
            const resolved = resolveAsset(key)
            if (!resolved || seenKeys.has(resolved.matchedKey)) return resolved?.matchedKey
            seenKeys.add(resolved.matchedKey)
            moduleAssets.push({
                key: resolved.matchedKey,
                type,
                label,
                size: resolved.size,
                missing: !resolved.exists
            })
            return resolved.matchedKey
        }

        const iconKey = addModuleAsset(module.icon, 'moduleIcon', language.storageModuleIcon)
        for (const asset of module.assets || []) {
            if (Array.isArray(asset) && asset[1]) {
                addModuleAsset(asset[1], 'moduleAsset', asset[0] || asset[2] || language.storageModuleAsset)
            }
        }

        const missingCount = moduleAssets.filter((a) => a.missing).length

        modules.push({
            id: storageId,
            name: displayName || language.storageUnnamedModule,
            iconKey: iconKey || module.icon,
            totalAssets: moduleAssets.length,
            totalSizeBytes: moduleAssets.reduce((sum, asset) => sum + asset.size, 0),
            assets: moduleAssets,
            missingAssetsCount: missingCount
        })
    }

    // Include persona icons
    for (const persona of (settingsStore.state.personas || [])) {
        if (persona?.icon) {
            resolveAsset(persona.icon)
        }
    }

    // Include user icon & global custom background
    if (settingsStore.state.userIcon) {
        resolveAsset(settingsStore.state.userIcon)
    }
    if (settingsStore.state.customBackground) {
        resolveAsset(settingsStore.state.customBackground)
    }

    // Include character order folder icons
    if (Array.isArray(settingsStore.state.characterOrder)) {
        for (const item of settingsStore.state.characterOrder) {
            if (typeof item === 'object' && item && 'imgFile' in item && typeof (item as any).imgFile === 'string') {
                resolveAsset((item as any).imgFile)
            }
        }
    }

    // Identify orphan assets on currently viewed storage
    const orphans: NodeStorageAssetItem[] = []
    let orphanSize = 0
    if (assetDetails?.assets) {
        for (const asset of assetDetails.assets) {
            let isReferenced = false

            if (isThumbnailKey(asset.key)) {
                // If it's a thumbnail, check whether its parent original asset is referenced
                const originalKey = extractOriginalKeyFromThumbnail(asset.key)
                if (originalKey) {
                    const originalCandidates = generateKeyCandidates(originalKey)
                    isReferenced = originalCandidates.some((cand) => referencedKeys.has(cand))
                }
            } else {
                const candidates = generateKeyCandidates(asset.key)
                isReferenced = candidates.some((cand) => referencedKeys.has(cand))
            }

            if (!isReferenced) {
                orphans.push(asset)
                orphanSize += asset.size
            }
        }
    }

    const totalMissingAssets =
        bots.reduce((sum, b) => sum + b.missingAssetsCount, 0) +
        modules.reduce((sum, m) => sum + m.missingAssetsCount, 0)

    return {
        bots,
        modules,
        orphanAssets: orphans,
        orphanSizeBytes: orphanSize,
        totalMissingAssets
    }
}
