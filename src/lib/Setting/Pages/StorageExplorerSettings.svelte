<script lang="ts">
    import { onMount } from 'svelte'
    import {
        ArrowDownIcon,
        ArrowUpIcon,
        CheckIcon,
        ChevronLeftIcon,
        CircleAlertIcon,
        DatabaseIcon,
        HardDriveIcon,
        Image as ImageIcon,
        LayersIcon,
        MusicIcon,
        RefreshCwIcon,
        SearchIcon,
        Trash2Icon,
        UserIcon,
        XIcon,
        SlidersHorizontalIcon,
        SparklesIcon,
        ExternalLinkIcon,
        ServerIcon,
        FolderArchiveIcon,
        FolderSyncIcon,
        FolderXIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage, readImage } from 'src/ts/globalApi.svelte'
    import { DBState, MobileGUI } from 'src/ts/stores.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import { getMimeType } from 'src/ts/media'
    import type {
        NodeS3ProgressEvent,
        NodeS3ServerConfig,
        NodeStorageAssetDetails,
        NodeStorageAssetItem,
        NodeStorageSummary
    } from 'src/ts/storage/nodeS3Storage'

    interface Props {
        close?: () => void
    }

    const { close }: Props = $props()

    type TabType = 'bots' | 'backend' | 'files'
    let currentTab = $state<TabType>('bots')

    // Dual storage target: 's3', 'azuresql', or 'fs'
    let viewTarget = $state<'s3' | 'azuresql' | 'fs'>('s3')

    let loading = $state(true)
    let busy = $state(false)
    let loadError = $state('')

    // Storage summary (both storages)
    let storageSummary = $state<NodeStorageSummary | null>(null)

    // Backend config
    let config = $state<NodeS3ServerConfig | null>(null)
    let enabled = $state(false)
    let storageType = $state<'fs' | 's3' | 'azuresql'>('fs')
    let endpoint = $state('')
    let bucket = $state('risuai-assets')
    let region = $state('us-east-1')
    let accessKeyId = $state('')
    let secretAccessKey = $state('')
    let forcePathStyle = $state(true)
    let autoCreateBucket = $state(true)
    let testingConnection = $state(false)
    // Azure SQL asset storage fields
    let azureServer = $state('')
    let azureDatabase = $state('')
    let azureUser = $state('')
    let azurePassword = $state('')
    let azurePort = $state('1433')

    // Migration / Rollback / Clean
    let migrating = $state(false)
    let rollingBack = $state(false)
    let purgingLocal = $state(false)
    let activeTask = $state<'migrate' | 'rollback' | null>(null)
    let progressData = $state<NodeS3ProgressEvent | null>(null)

    // Current target asset details
    let assetDetails = $state<NodeStorageAssetDetails | null>(null)
    let assetMap = $state<Map<string, NodeStorageAssetItem>>(new Map())

    // Bot asset analysis
    interface BotAssetItem {
        key: string
        type: 'avatar' | 'emotion' | 'additional' | 'ccAsset' | 'background' | 'audio' | 'other'
        label: string
        size: number
    }

    interface BotStorageInfo {
        id: string
        name: string
        avatarKey?: string
        totalAssets: number
        totalSizeBytes: number
        assets: BotAssetItem[]
        emotionsCount: number
        additionalAssetsCount: number
        audioCount: number
    }

    let botAnalysis = $state<BotStorageInfo[]>([])
    let selectedBot = $state<BotStorageInfo | null>(null)
    let botSearch = $state('')
    let botSort = $state<'size_desc' | 'size_asc' | 'count_desc' | 'name_asc'>('size_desc')

    // Orphan assets
    let orphanAssets = $state<NodeStorageAssetItem[]>([])
    let orphanSizeBytes = $state(0)
    let cleaningOrphans = $state(false)

    // All files explorer
    let fileSearch = $state('')
    let fileFilter = $state<'all' | 'image' | 'audio' | 'orphan'>('all')
    let selectedFileKeys = $state<Set<string>>(new Set())
    let previewAssetKey = $state<string | null>(null)
    let previewImageUrl = $state<string | null>(null)

    // Thumbnail cache
    let thumbnailUrls = $state<Map<string, string>>(new Map())

    function getNodeStorage(): NodeStorage {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    function formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B'
        const k = 1024
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
    }

    async function loadData() {
        loading = true
        loadError = ''
        try {
            const storage = getNodeStorage()
            
            // Load dual storage summary
            try {
                storageSummary = await storage.s3.getStorageSummary()
                config = storageSummary.config
                enabled = config.enabled
                storageType = config.storageType || 'fs'
                endpoint = config.endpoint || ''
                bucket = config.bucket || 'risuai-assets'
                region = config.region || 'us-east-1'
                forcePathStyle = config.forcePathStyle
                autoCreateBucket = config.autoCreateBucket
                accessKeyId = config.accessKeyId || ''
                azureServer = config.azureServer || ''
                azureDatabase = config.azureDatabase || ''
                azureUser = config.azureUser || ''
                azurePort = String(config.azurePort || 1433)
                
                // Default viewTarget to the active remote backend (or fs when none).
                const active = config.storageType
                if (active === 'azuresql') {
                    viewTarget = 'azuresql'
                } else if (active === 's3') {
                    viewTarget = 's3'
                } else if (viewTarget === 's3' && !config.enabled) {
                    viewTarget = 'fs'
                }
            } catch (err) {
                config = await storage.s3.getServerConfig()
                enabled = config.enabled
                storageType = config.storageType || 'fs'
            }

            await loadTargetAssets()
        } catch (error: any) {
            loadError = error?.message || `${error}`
        } finally {
            loading = false
        }
    }

    async function loadTargetAssets() {
        try {
            const storage = getNodeStorage()
            assetDetails = await storage.s3.getAssetDetails(viewTarget)
            const map = new Map<string, NodeStorageAssetItem>()
            for (const item of assetDetails.assets) {
                map.set(item.key, item)
            }
            assetMap = map
            analyzeStorage()
        } catch (err: any) {
            console.warn('Failed to load asset details for target:', viewTarget, err)
            assetDetails = {
                storageType: viewTarget,
                totalObjects: 0,
                totalSizeBytes: 0,
                assets: []
            }
            assetMap = new Map()
            analyzeStorage()
        }
    }

    async function switchViewTarget(target: 's3' | 'fs' | 'azuresql') {
        if (viewTarget === target) return
        viewTarget = target
        loading = true
        selectedFileKeys.clear()
        selectedFileKeys = new Set(selectedFileKeys)
        await loadTargetAssets()
        loading = false
    }

    function analyzeStorage() {
        const characters = DBState.db.characters || []
        const referencedKeys = new Set<string>()
        const bots: BotStorageInfo[] = []

        for (const char of characters) {
            if (!char) continue
            const botAssets: BotAssetItem[] = []
            const seenKeys = new Set<string>()

            function addAsset(key: string | undefined, type: BotAssetItem['type'], label: string) {
                if (!key || typeof key !== 'string') return
                let normalizedKey = key
                if (!normalizedKey.startsWith('assets/') && !normalizedKey.includes('/')) {
                    normalizedKey = `assets/${key}`
                }
                let item = assetMap.get(normalizedKey) || assetMap.get(key)
                const size = item?.size ?? 0

                if (!seenKeys.has(normalizedKey)) {
                    seenKeys.add(normalizedKey)
                    referencedKeys.add(normalizedKey)
                    referencedKeys.add(key)
                    botAssets.push({
                        key: normalizedKey,
                        type,
                        label,
                        size
                    })
                }
            }

            // Main avatar
            if (char.image) {
                addAsset(char.image, 'avatar', 'Main Avatar')
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
            const ccAssetsList = (char as any).ccAssets
            if (Array.isArray(ccAssetsList)) {
                for (const cca of ccAssetsList) {
                    if (cca?.uri) {
                        addAsset(cca.uri, 'ccAsset', cca.name || cca.type || 'CC Asset')
                        additionalCount++
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

            const totalSize = botAssets.reduce((sum, a) => sum + a.size, 0)

            bots.push({
                id: (char as any).id || (char as any).chaId || char.name,
                name: char.name || 'Unnamed Bot',
                avatarKey: char.image,
                totalAssets: botAssets.length,
                totalSizeBytes: totalSize,
                assets: botAssets,
                emotionsCount,
                additionalAssetsCount: additionalCount,
                audioCount
            })
        }

        botAnalysis = bots

        // Identify orphan assets on currently viewed storage
        const orphans: NodeStorageAssetItem[] = []
        let orphanSize = 0
        if (assetDetails?.assets) {
            for (const asset of assetDetails.assets) {
                if (!referencedKeys.has(asset.key) && !referencedKeys.has(asset.key.replace(/^assets\//, ''))) {
                    orphans.push(asset)
                    orphanSize += asset.size
                }
            }
        }
        orphanAssets = orphans
        orphanSizeBytes = orphanSize
    }

    // Filter & sort bots
    const filteredBots = $derived(() => {
        let list = [...botAnalysis]
        if (botSearch.trim()) {
            const query = botSearch.trim().toLowerCase()
            list = list.filter(b => b.name.toLowerCase().includes(query))
        }
        if (botSort === 'size_desc') {
            list.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
        } else if (botSort === 'size_asc') {
            list.sort((a, b) => a.totalSizeBytes - b.totalSizeBytes)
        } else if (botSort === 'count_desc') {
            list.sort((a, b) => b.totalAssets - a.totalAssets)
        } else if (botSort === 'name_asc') {
            list.sort((a, b) => a.name.localeCompare(b.name))
        }
        return list
    })

    // Filter raw files
    const filteredFiles = $derived(() => {
        if (!assetDetails?.assets) return []
        let list = [...assetDetails.assets]

        if (fileSearch.trim()) {
            const query = fileSearch.trim().toLowerCase()
            list = list.filter(f => f.key.toLowerCase().includes(query))
        }

        if (fileFilter === 'image') {
            list = list.filter(f => /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(f.key))
        } else if (fileFilter === 'audio') {
            list = list.filter(f => /\.(mp3|wav|ogg|flac|aac|m4a|webm)$/i.test(f.key))
        } else if (fileFilter === 'orphan') {
            const orphanSet = new Set(orphanAssets.map(o => o.key))
            list = list.filter(f => orphanSet.has(f.key))
        }

        return list
    })

    async function loadThumbnail(key: string) {
        if (!key || thumbnailUrls.has(key)) return
        try {
            const data = await readImage(key)
            if (data && data.length > 0) {
                const blob = new Blob([data as unknown as BlobPart], { type: getMimeType(key) })
                const url = URL.createObjectURL(blob)
                thumbnailUrls.set(key, url)
                thumbnailUrls = new Map(thumbnailUrls)
            }
        } catch {
            // Ignore thumbnail error
        }
    }

    async function testConnection() {
        testingConnection = true
        try {
            const storage = getNodeStorage()
            if (storageType === 'azuresql') {
                const result = await storage.s3.testConnection({
                    enabled: true,
                    storageType: 'azuresql',
                    azureServer: azureServer.trim(),
                    azureDatabase: azureDatabase.trim(),
                    azureUser: azureUser.trim(),
                    azurePassword: azurePassword,
                    azurePort: parseInt(azurePort, 10) || 1433,
                })
                if (result.success) {
                    alertNormal(result.message || language.azureSqlConnectionSuccess)
                } else {
                    alertError(result.message || language.azureSqlConnectionFailed)
                }
            } else {
                const result = await storage.s3.testConnection({
                    enabled: true,
                    storageType: 's3',
                    endpoint: endpoint.trim(),
                    bucket: bucket.trim(),
                    region: region.trim(),
                    accessKeyId: accessKeyId.trim(),
                    secretAccessKey: secretAccessKey.trim(),
                    forcePathStyle,
                    autoCreateBucket
                })
                if (result.success) {
                    alertNormal(result.message || language.s3ConnectionSuccess)
                } else {
                    alertError(result.message || language.s3ConnectionFailed)
                }
            }
        } catch (error) {
            alertError(error)
        } finally {
            testingConnection = false
        }
    }

    async function applyConfiguration() {
        if (!config || config.managedByEnvironment || busy) return
        if (!await alertConfirm(language.s3ApplyConfirm)) return

        busy = true
        try {
            const storage = getNodeStorage()
            if (storageType === 'azuresql') {
                await storage.s3.configureServer({
                    enabled,
                    storageType: 'azuresql',
                    azureServer: azureServer.trim(),
                    azureDatabase: azureDatabase.trim(),
                    azureUser: azureUser.trim(),
                    azurePassword: azurePassword || undefined,
                    azurePort: parseInt(azurePort, 10) || 1433,
                })
            } else if (storageType === 's3') {
                await storage.s3.configureServer({
                    enabled,
                    storageType: 's3',
                    endpoint: endpoint.trim(),
                    bucket: bucket.trim(),
                    region: region.trim(),
                    accessKeyId: accessKeyId.trim() || undefined,
                    secretAccessKey: secretAccessKey.trim() || undefined,
                    forcePathStyle,
                    autoCreateBucket
                })
            } else {
                // fs
                await storage.s3.configureServer({
                    enabled: false,
                    storageType: 'fs',
                })
            }
            alertNormal(language.s3ApplySuccess)
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    async function migrateToS3() {
        if (storageType === 'fs' || !config?.enabled) {
            alertError(language.s3MustBeEnabledToMigrate)
            return
        }
        if (!await alertConfirm(language.s3MigrateConfirm)) return

        migrating = true
        activeTask = 'migrate'
        progressData = {
            type: 'progress',
            current: 0,
            total: 0,
            percentage: 0,
            migrated: 0,
            skipped: 0
        }

        try {
            const storage = getNodeStorage()
            const result = await storage.s3.migrateLocalToS3((event) => {
                progressData = event
            })
            alertNormal(language.s3MigrateSuccess(result.migrated, result.skipped, result.total))
            await loadData()
        } catch (error) {
            alertError(error)
        } finally {
            migrating = false
            activeTask = null
            progressData = null
        }
    }

    async function rollbackToLocal() {
        if (!await alertConfirm(language.s3RollbackConfirm)) return

        rollingBack = true
        activeTask = 'rollback'
        progressData = {
            type: 'progress',
            current: 0,
            total: 0,
            percentage: 0,
            downloaded: 0
        }

        try {
            const storage = getNodeStorage()
            const result = await storage.s3.rollbackS3ToLocal((event) => {
                progressData = event
            })
            alertNormal(language.s3RollbackSuccess(result.downloaded, result.total))
            await loadData()
        } catch (error) {
            alertError(error)
        } finally {
            rollingBack = false
            activeTask = null
            progressData = null
        }
    }

    async function cleanOrphanAssets() {
        if (orphanAssets.length === 0) return
        const formattedSize = formatBytes(orphanSizeBytes)
        if (!await alertConfirm(language.storageCleanOrphanConfirm(orphanAssets.length, formattedSize))) {
            return
        }

        cleaningOrphans = true
        try {
            const storage = getNodeStorage()
            const keysToDelete = orphanAssets.map(a => a.key)
            const result = await storage.s3.deleteAssetKeys(keysToDelete, viewTarget)
            alertNormal(language.storageCleanOrphanSuccess(result.deleted, formattedSize))
            await loadData()
        } catch (error) {
            alertError(error)
        } finally {
            cleaningOrphans = false
        }
    }

    async function purgeLocalFsAssets() {
        const localSize = storageSummary?.localFs?.totalSizeBytes ?? 0
        const formattedSize = formatBytes(localSize)
        if (!await alertConfirm(language.storagePurgeLocalFsConfirm(formattedSize))) {
            return
        }

        purgingLocal = true
        try {
            const storage = getNodeStorage()
            const result = await storage.s3.cleanLocalFs()
            alertNormal(language.storagePurgeLocalFsSuccess(result.deleted, formatBytes(result.freedBytes)))
            await loadData()
        } catch (error) {
            alertError(error)
        } finally {
            purgingLocal = false
        }
    }

    async function deleteSelectedFiles() {
        if (selectedFileKeys.size === 0) return
        if (!await alertConfirm(language.storageDeleteConfirm(selectedFileKeys.size))) return

        busy = true
        try {
            const storage = getNodeStorage()
            const keysToDelete = Array.from(selectedFileKeys)
            const result = await storage.s3.deleteAssetKeys(keysToDelete, viewTarget)
            alertNormal(language.storageDeleteSuccess(result.deleted))
            selectedFileKeys.clear()
            selectedFileKeys = new Set(selectedFileKeys)
            await loadData()
        } catch (error) {
            alertError(error)
        } finally {
            busy = false
        }
    }

    function toggleSelectFile(key: string) {
        if (selectedFileKeys.has(key)) {
            selectedFileKeys.delete(key)
        } else {
            selectedFileKeys.add(key)
        }
        selectedFileKeys = new Set(selectedFileKeys)
    }

    function toggleSelectAllFiles() {
        const currentList = filteredFiles()
        if (selectedFileKeys.size === currentList.length && currentList.length > 0) {
            selectedFileKeys.clear()
        } else {
            selectedFileKeys = new Set(currentList.map(f => f.key))
        }
    }

    async function openPreview(key: string) {
        previewAssetKey = key
        try {
            const data = await readImage(key)
            if (data && data.length > 0) {
                const blob = new Blob([data as unknown as BlobPart], { type: getMimeType(key) })
                previewImageUrl = URL.createObjectURL(blob)
            }
        } catch {
            previewImageUrl = null
        }
    }

    function closePreview() {
        previewAssetKey = null
        if (previewImageUrl) {
            URL.revokeObjectURL(previewImageUrl)
            previewImageUrl = null
        }
    }

    onMount(() => {
        loadData()
    })
</script>

<div class="fixed inset-0 z-50 flex flex-col bg-bgcolor text-textcolor overflow-hidden animate-in fade-in duration-200">
    <!-- Header -->
    <header class="flex h-14 shrink-0 items-center justify-between border-b border-darkborderc bg-darkbg px-4 py-2.5">
        <div class="flex items-center gap-3">
            <button
                class="flex h-9 w-9 items-center justify-center rounded-lg border border-darkborderc bg-darkbg hover:bg-selected/40 transition-colors"
                onclick={close}
                title="Back / Close"
            >
                <ChevronLeftIcon class="h-5 w-5" />
            </button>
            <div class="flex items-center gap-2">
                <HardDriveIcon class="h-5 w-5 text-blue-400" />
                <h2 class="text-base font-bold sm:text-lg">{language.storageExplorer}</h2>
            </div>
        </div>

        <!-- Target Storage Toggle Pill (S3 / Azure SQL / Local FS) -->
        <div class="flex items-center gap-2">
            <div class="flex items-center rounded-lg border border-darkborderc bg-darkbg/90 p-0.5 text-xs">
                {#if config?.enabled && config.storageType !== 'azuresql'}
                    <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all {viewTarget === 's3' ? 'bg-blue-600 text-white font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => switchViewTarget('s3')}
                    >
                        <ServerIcon class="h-3.5 w-3.5" />
                        <span>S3 (RustFS)</span>
                        <span class="rounded-full bg-black/30 px-1.5 py-0.2 text-[10px]">{formatBytes(storageSummary?.s3?.totalSizeBytes ?? 0)}</span>
                    </button>
                {/if}
                {#if config?.enabled && config.storageType === 'azuresql'}
                    <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all {viewTarget === 'azuresql' ? 'bg-sky-600 text-white font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => switchViewTarget('azuresql')}
                    >
                        <DatabaseIcon class="h-3.5 w-3.5" />
                        <span>Azure SQL</span>
                        <span class="rounded-full bg-black/30 px-1.5 py-0.2 text-[10px]">{formatBytes(storageSummary?.azuresql?.totalSizeBytes ?? 0)}</span>
                    </button>
                {/if}

                <button
                    type="button"
                    class="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all {viewTarget === 'fs' ? 'bg-indigo-600 text-white font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                    onclick={() => switchViewTarget('fs')}
                >
                    <FolderArchiveIcon class="h-3.5 w-3.5" />
                    <span>로컬 FS</span>
                    <span class="rounded-full bg-black/30 px-1.5 py-0.2 text-[10px]">{formatBytes(storageSummary?.localFs?.totalSizeBytes ?? 0)}</span>
                </button>
            </div>

            <button
                class="flex h-9 items-center gap-1.5 rounded-lg border border-darkborderc bg-darkbg px-3 text-xs font-medium hover:bg-selected/40 transition-colors disabled:opacity-50"
                disabled={loading || busy}
                onclick={loadData}
            >
                <RefreshCwIcon class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
                <span class="hidden sm:inline">새로고침</span>
            </button>
            <button
                class="flex h-9 w-9 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkborderc/50 hover:text-textcolor transition-colors"
                onclick={close}
            >
                <XIcon class="h-5 w-5" />
            </button>
        </div>
    </header>

    <!-- Dual Storage Overview Banner -->
    <div class="border-b border-darkborderc bg-darkbg/50 px-4 py-3">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5 sm:gap-3">
            <!-- S3 Object Storage Card -->
            <div class="relative flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1 text-[11px] font-medium text-textcolor2 sm:text-xs">
                        <ServerIcon class="h-3.5 w-3.5 text-blue-400" />
                        <span>S3 객체 스토리지</span>
                    </div>
                    {#if config?.enabled && config.storageType === 's3'}
                        <span class="rounded-full bg-blue-500/20 px-2 py-0.2 text-[10px] font-bold text-blue-300">
                            {storageSummary?.activeType === 's3' ? '메인 활성' : '활성'}
                        </span>
                    {:else}
                        <span class="rounded-full bg-darkbutton px-2 py-0.2 text-[10px] text-textcolor2">비활성</span>
                    {/if}
                </div>
                <div class="mt-1 text-base font-bold text-textcolor sm:text-xl">
                    {formatBytes(storageSummary?.s3?.totalSizeBytes ?? 0)}
                    <span class="text-xs font-normal text-textcolor2">({(storageSummary?.s3?.totalObjects ?? 0).toLocaleString()}개)</span>
                </div>
            </div>

            <!-- Azure SQL Storage Card -->
            <div class="relative flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1 text-[11px] font-medium text-textcolor2 sm:text-xs">
                        <DatabaseIcon class="h-3.5 w-3.5 text-sky-400" />
                        <span>Azure SQL</span>
                    </div>
                    {#if config?.enabled && config.storageType === 'azuresql'}
                        <span class="rounded-full bg-sky-500/20 px-2 py-0.2 text-[10px] font-bold text-sky-300">
                            {storageSummary?.activeType === 'azuresql' ? '메인 활성' : '활성'}
                        </span>
                    {:else}
                        <span class="rounded-full bg-darkbutton px-2 py-0.2 text-[10px] text-textcolor2">비활성</span>
                    {/if}
                </div>
                <div class="mt-1 text-base font-bold text-textcolor sm:text-xl">
                    {formatBytes(storageSummary?.azuresql?.totalSizeBytes ?? 0)}
                    <span class="text-xs font-normal text-textcolor2">({(storageSummary?.azuresql?.totalObjects ?? 0).toLocaleString()}개)</span>
                </div>
            </div>

            <!-- Local FS Storage Card (with Purge action if S3 active) -->
            <div class="relative flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1 text-[11px] font-medium text-textcolor2 sm:text-xs">
                        <FolderArchiveIcon class="h-3.5 w-3.5 text-indigo-400" />
                        <span>로컬 FS 스토리지</span>
                    </div>
                    <div class="flex items-center gap-1">
                        {#if storageSummary?.activeType === 'fs'}
                            <span class="rounded-full bg-green-500/20 px-2 py-0.2 text-[10px] font-bold text-green-300">메인 활성</span>
                        {:else}
                            <span class="rounded-full bg-darkbutton px-2 py-0.2 text-[10px] text-textcolor2">대기</span>
                            {#if (storageSummary?.localFs?.totalObjects ?? 0) > 0}
                                <button
                                    class="rounded-md bg-rose-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors"
                                    disabled={purgingLocal || busy}
                                    onclick={purgeLocalFsAssets}
                                    title="S3로 옮긴 후 남아있는 로컬 디스크 에셋을 삭제하여 로컬 디스크 공간 확보"
                                >
                                    {purgingLocal ? '비우는 중...' : '로컬 비우기'}
                                </button>
                            {/if}
                        {/if}
                    </div>
                </div>
                <div class="mt-1 text-base font-bold text-textcolor sm:text-xl">
                    {formatBytes(storageSummary?.localFs?.totalSizeBytes ?? 0)}
                    <span class="text-xs font-normal text-textcolor2">({(storageSummary?.localFs?.totalObjects ?? 0).toLocaleString()}개)</span>
                </div>
            </div>

            <!-- Managed Bots Count -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
                <div class="text-[11px] font-medium text-textcolor2 sm:text-xs">{language.storageTotalBots}</div>
                <div class="mt-1 text-base font-bold text-textcolor sm:text-xl">
                    {botAnalysis.length} <span class="text-xs font-normal text-textcolor2">캐릭터</span>
                </div>
            </div>

            <!-- Orphan Assets & Cleaner for current target -->
            <div class="flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
                <div class="flex items-center justify-between">
                    <div class="text-[11px] font-medium text-textcolor2 sm:text-xs">
                        {language.storageOrphanAssets} ({viewTarget.toUpperCase()})
                    </div>
                    {#if orphanAssets.length > 0}
                        <button
                            class="rounded-md bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors"
                            disabled={cleaningOrphans || busy}
                            onclick={cleanOrphanAssets}
                        >
                            {cleaningOrphans ? '정리 중...' : language.storageCleanOrphan}
                        </button>
                    {/if}
                </div>
                <div class="mt-1 text-base font-bold text-textcolor sm:text-xl">
                    {orphanAssets.length} <span class="text-xs font-normal text-textcolor2">({formatBytes(orphanSizeBytes)})</span>
                </div>
            </div>
        </div>
    </div>

    <!-- Navigation Tabs -->
    <div class="flex shrink-0 border-b border-darkborderc bg-darkbg px-4">
        <button
            class="flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors {currentTab === 'bots' ? 'border-blue-500 text-blue-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
            onclick={() => currentTab = 'bots'}
        >
            <UserIcon class="h-4 w-4" />
            <span>{language.storageTabBots}</span>
            <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[11px]">{botAnalysis.length}</span>
        </button>

        <button
            class="flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors {currentTab === 'backend' ? 'border-blue-500 text-blue-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
            onclick={() => currentTab = 'backend'}
        >
            <DatabaseIcon class="h-4 w-4" />
            <span>{language.storageTabBackend}</span>
        </button>

        <button
            class="flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors {currentTab === 'files' ? 'border-blue-500 text-blue-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
            onclick={() => currentTab = 'files'}
        >
            <LayersIcon class="h-4 w-4" />
            <span>{language.storageTabAllFiles} ({viewTarget.toUpperCase()})</span>
            <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[11px]">{assetDetails?.totalObjects ?? 0}</span>
        </button>
    </div>

    <!-- Main Content Body -->
    <main class="flex-1 overflow-y-auto p-4">
        {#if loadError}
            <div class="mb-4 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
                <CircleAlertIcon class="h-5 w-5 shrink-0" />
                <span>{loadError}</span>
            </div>
        {/if}

        <!-- TAB 1: BOTS BREAKDOWN -->
        {#if currentTab === 'bots'}
            <div class="flex flex-col gap-4">
                <!-- Controls: Search & Sort -->
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="relative min-w-[240px] flex-1 max-w-md">
                        <SearchIcon class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-textcolor2" />
                        <input
                            type="text"
                            bind:value={botSearch}
                            placeholder={language.storageSearchBots}
                            class="w-full rounded-lg border border-darkborderc bg-darkbg py-2 pl-9 pr-3 text-sm text-textcolor placeholder-textcolor2 focus:border-blue-500 focus:outline-hidden"
                        />
                    </div>

                    <div class="flex items-center gap-2">
                        <span class="text-xs text-textcolor2 hidden sm:inline">정렬:</span>
                        <select
                            bind:value={botSort}
                            class="rounded-lg border border-darkborderc bg-darkbg px-3 py-2 text-xs font-medium text-textcolor focus:border-blue-500 focus:outline-hidden"
                        >
                            <option value="size_desc">{language.storageSortSizeDesc}</option>
                            <option value="size_asc">{language.storageSortSizeAsc}</option>
                            <option value="count_desc">{language.storageSortCountDesc}</option>
                            <option value="name_asc">{language.storageSortNameAsc}</option>
                        </select>
                    </div>
                </div>

                <!-- Bot Cards Grid -->
                {#if filteredBots().length === 0}
                    <div class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-darkborderc py-16 text-textcolor2">
                        <UserIcon class="h-12 w-12 opacity-30" />
                        <p class="mt-2 text-sm">{language.storageNoBotsFound}</p>
                    </div>
                {:else}
                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {#each filteredBots() as bot (bot.id)}
                            <button
                                type="button"
                                class="group relative flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg/70 p-4 text-left transition-all hover:border-darkborderc/80 hover:bg-darkbg hover:shadow-lg cursor-pointer w-full"
                                onclick={() => selectedBot = bot}
                            >
                                <div class="flex items-start gap-3 w-full">
                                    <!-- Bot Avatar Thumbnail -->
                                    <div class="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-darkborderc bg-darkbutton">
                                        {#if bot.avatarKey}
                                            {@const _ = loadThumbnail(bot.avatarKey)}
                                            {#if thumbnailUrls.has(bot.avatarKey)}
                                                <img src={thumbnailUrls.get(bot.avatarKey)} alt={bot.name} class="h-full w-full object-cover" />
                                            {:else}
                                                <div class="flex h-full w-full items-center justify-center text-xs text-textcolor2">...</div>
                                            {/if}
                                        {:else}
                                            <div class="flex h-full w-full items-center justify-center text-textcolor2">
                                                <UserIcon class="h-6 w-6" />
                                            </div>
                                        {/if}
                                    </div>

                                    <!-- Bot Title & Size -->
                                    <div class="min-w-0 flex-1">
                                        <h4 class="truncate text-sm font-bold text-textcolor group-hover:text-blue-400 transition-colors">
                                            {bot.name}
                                        </h4>
                                        <div class="mt-1 flex items-center gap-2">
                                            <span class="rounded-md bg-blue-500/15 px-2 py-0.5 text-xs font-semibold text-blue-300">
                                                {formatBytes(bot.totalSizeBytes)}
                                            </span>
                                            <span class="text-xs text-textcolor2">
                                                {bot.totalAssets}개 에셋
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <!-- Breakdown Pills -->
                                <div class="mt-3 flex flex-wrap gap-1.5 border-t border-darkborderc/50 pt-2.5 text-[11px] text-textcolor2 w-full">
                                    {#if bot.emotionsCount > 0}
                                        <span class="rounded-md bg-darkbutton/60 px-2 py-0.5">
                                            {language.storageEmotions}: {bot.emotionsCount}
                                        </span>
                                    {/if}
                                    {#if bot.additionalAssetsCount > 0}
                                        <span class="rounded-md bg-darkbutton/60 px-2 py-0.5">
                                            {language.storageAdditional}: {bot.additionalAssetsCount}
                                        </span>
                                    {/if}
                                    {#if bot.audioCount > 0}
                                        <span class="rounded-md bg-darkbutton/60 px-2 py-0.5">
                                            {language.storageAudio}: {bot.audioCount}
                                        </span>
                                    {/if}
                                </div>
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- TAB 2: STORAGE BACKEND (S3 / FS) -->
        {#if currentTab === 'backend'}
            <div class="max-w-3xl space-y-6">
                <!-- Status & Mode Switch -->
                <div class="rounded-xl border border-darkborderc bg-darkbg p-5 shadow-xs">
                    <div class="flex items-center justify-between">
                        <div>
                            <h3 class="text-base font-semibold text-textcolor">{language.s3Storage}</h3>
                            <p class="mt-1 text-xs text-textcolor2">{language.s3StorageDescription}</p>
                        </div>
                        {#if config}
                            <span class="rounded-full px-3 py-1 text-xs font-medium {config.enabled ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-darkbutton text-textcolor2'}">
                                {config.storageType === 'azuresql' ? 'Azure SQL 활성화됨' : (config.storageType === 's3' ? 'S3 / RustFS 활성화됨' : 'Local FileSystem 사용 중')}
                            </span>
                        {/if}
                    </div>

                    {#if config?.managedByEnvironment}
                        <div class="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                            {language.s3EnvironmentManaged}
                        </div>
                    {/if}

                    <!-- Storage backend selector -->
                    <div class="mt-4">
                        <label class="block text-xs font-medium text-textcolor2" for="backend-storage-type">
                            {language.s3StatsStorageType}
                        </label>
                        <select
                            id="backend-storage-type"
                            class="mt-1 w-full rounded-md border border-darkborderc bg-bgcolor/40 px-3 py-2 text-textcolor {config?.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                            bind:value={storageType}
                        >
                            <option value="fs">Local Filesystem</option>
                            <option value="s3">S3 / RustFS</option>
                            <option value="azuresql">Azure SQL (MSSQL)</option>
                        </select>
                    </div>

                    <div class="mt-4">
                        {#if storageType !== 'fs'}
                            <CheckInput
                                bind:check={enabled}
                                className={config?.managedByEnvironment ? 'pointer-events-none opacity-50' : ''}
                                name={storageType === 'azuresql' ? language.useAzureSqlStorage : language.useS3Storage}
                            />
                        {/if}
                    </div>
                </div>

                {#if storageType === 's3'}
                    <!-- Form Fields -->
                    <div class="rounded-xl border border-darkborderc bg-darkbg p-5 shadow-xs">
                        <h4 class="text-sm font-semibold text-textcolor">연결 설정</h4>

                        <div class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="s3-endpoint">
                                    {language.s3Endpoint}
                                </label>
                                <TextInput
                                    id="s3-endpoint"
                                    bind:value={endpoint}
                                    fullwidth={true}
                                    disabled={config?.managedByEnvironment}
                                    placeholder="http://127.0.0.1:9000"
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="s3-bucket">
                                    {language.s3Bucket}
                                </label>
                                <TextInput
                                    id="s3-bucket"
                                    bind:value={bucket}
                                    fullwidth={true}
                                    disabled={config?.managedByEnvironment}
                                    placeholder="risuai-assets"
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="s3-access-key">
                                    {language.s3AccessKeyId}
                                </label>
                                <TextInput
                                    id="s3-access-key"
                                    bind:value={accessKeyId}
                                    fullwidth={true}
                                    disabled={config?.managedByEnvironment}
                                    placeholder="rustfsadmin"
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="s3-secret-key">
                                    {language.s3SecretAccessKey}
                                </label>
                                <TextInput
                                    id="s3-secret-key"
                                    bind:value={secretAccessKey}
                                    hideText={true}
                                    fullwidth={true}
                                    disabled={config?.managedByEnvironment}
                                    placeholder={config?.hasSecretAccessKey ? '•••••••••••• (저장됨 / 변경 시 입력)' : 'rustfsadmin'}
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="s3-region">
                                    {language.s3Region}
                                </label>
                                <TextInput
                                    id="s3-region"
                                    bind:value={region}
                                    fullwidth={true}
                                    disabled={config?.managedByEnvironment}
                                    placeholder="us-east-1"
                                    className="mt-1"
                                />
                            </div>
                        </div>

                        <div class="mt-4 flex flex-col gap-2">
                            <CheckInput bind:check={forcePathStyle} name={language.s3ForcePathStyle} />
                            <CheckInput bind:check={autoCreateBucket} name={language.s3AutoCreateBucket} />
                        </div>

                        {#if !config?.managedByEnvironment}
                            <div class="mt-6 flex flex-wrap items-center gap-3">
                                <Button disabled={busy || testingConnection} onclick={testConnection}>
                                    {testingConnection ? language.s3Testing : language.s3TestConnection}
                                </Button>

                                <Button className="bg-selected hover:opacity-90 font-medium" disabled={busy} onclick={applyConfiguration}>
                                    {busy ? language.s3Applying : language.s3Apply}
                                </Button>
                            </div>
                        {/if}
                    </div>
                {:else if storageType === 'azuresql'}
                    <!-- Azure SQL Form Fields -->
                    <div class="rounded-xl border border-darkborderc bg-darkbg p-5 shadow-xs">
                        <h4 class="text-sm font-semibold text-textcolor">Azure SQL 연결 설정</h4>

                        {#if config?.azureManagedByEnvironment}
                            <p class="mt-3 rounded-md border border-borderc bg-bgcolor/40 p-2 text-sm text-textcolor2">
                                {language.azureSqlManagedByEnv}
                            </p>
                        {/if}

                        <div class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="azure-server">
                                    {language.azureSqlHost}
                                </label>
                                <TextInput
                                    id="azure-server"
                                    bind:value={azureServer}
                                    fullwidth={true}
                                    disabled={config?.azureManagedByEnvironment}
                                    placeholder="your-server.database.windows.net"
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="azure-database">
                                    {language.azureSqlDatabase}
                                </label>
                                <TextInput
                                    id="azure-database"
                                    bind:value={azureDatabase}
                                    fullwidth={true}
                                    disabled={config?.azureManagedByEnvironment}
                                    placeholder="risuai_assets"
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="azure-user">
                                    {language.azureSqlUser}
                                </label>
                                <TextInput
                                    id="azure-user"
                                    bind:value={azureUser}
                                    fullwidth={true}
                                    disabled={config?.azureManagedByEnvironment}
                                    placeholder="admin"
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="azure-password">
                                    {language.azureSqlPassword}
                                </label>
                                <TextInput
                                    id="azure-password"
                                    bind:value={azurePassword}
                                    hideText={true}
                                    fullwidth={true}
                                    disabled={config?.azureManagedByEnvironment}
                                    placeholder={config?.hasAzurePassword ? '•••••••••••• (저장됨 / 변경 시 입력)' : ''}
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="azure-port">
                                    {language.azureSqlPort}
                                </label>
                                <TextInput
                                    id="azure-port"
                                    bind:value={azurePort}
                                    fullwidth={true}
                                    disabled={config?.azureManagedByEnvironment}
                                    placeholder="1433"
                                    className="mt-1"
                                />
                            </div>
                        </div>

                        {#if !config?.azureManagedByEnvironment}
                            <div class="mt-6 flex flex-wrap items-center gap-3">
                                <Button disabled={busy || testingConnection} onclick={testConnection}>
                                    {testingConnection ? language.s3Testing : language.s3TestConnection}
                                </Button>

                                <Button className="bg-selected hover:opacity-90 font-medium" disabled={busy} onclick={applyConfiguration}>
                                    {busy ? language.s3Applying : language.s3Apply}
                                </Button>
                            </div>
                        {/if}
                    </div>
                {/if}

                <!-- Migration & Rollback Tools -->
                <div class="rounded-xl border border-darkborderc bg-darkbg p-5 shadow-xs">
                    <h4 class="text-sm font-semibold text-textcolor">{language.s3StatsAndTools}</h4>
                    <p class="mt-1 text-xs text-textcolor2">{language.s3StatsAndToolsDescription}</p>

                    <div class="mt-4 flex flex-wrap items-center gap-3">
                        <Button disabled={migrating || storageType === 'fs' || !config?.enabled} onclick={migrateToS3}>
                            {migrating ? language.s3Migrating : (storageType === 'azuresql' ? language.azureSqlStorageMigrateFromLocal : language.s3MigrateFromLocal)}
                        </Button>

                        <Button disabled={rollingBack || storageType === 'fs' || !config?.enabled} onclick={rollbackToLocal}>
                            {rollingBack ? language.s3RollingBack : (storageType === 'azuresql' ? language.azureSqlStorageRollbackToLocal : language.s3RollbackToLocal)}
                        </Button>

                        {#if config?.enabled && (storageSummary?.localFs?.totalObjects ?? 0) > 0}
                            <Button
                                className="bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 border border-rose-500/40"
                                disabled={purgingLocal || busy}
                                onclick={purgeLocalFsAssets}
                            >
                                {purgingLocal ? '로컬 비우는 중...' : '로컬 FS 잔여 에셋 일괄 비우기'}
                            </Button>
                        {/if}
                    </div>
                </div>
            </div>
        {/if}

        <!-- TAB 3: ALL FILES EXPLORER -->
        {#if currentTab === 'files'}
            <div class="flex flex-col gap-4">
                <!-- Controls: Search & Filter & Bulk Actions -->
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="relative min-w-[240px] flex-1 max-w-md">
                        <SearchIcon class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-textcolor2" />
                        <input
                            type="text"
                            bind:value={fileSearch}
                            placeholder={language.storageSearchFiles}
                            class="w-full rounded-lg border border-darkborderc bg-darkbg py-2 pl-9 pr-3 text-sm text-textcolor placeholder-textcolor2 focus:border-blue-500 focus:outline-hidden"
                        />
                    </div>

                    <!-- Filter pills -->
                    <div class="flex items-center gap-1 rounded-lg border border-darkborderc bg-darkbg p-1 text-xs">
                        <button
                            class="rounded-md px-2.5 py-1 transition-colors {fileFilter === 'all' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => fileFilter = 'all'}
                        >
                            {language.storageFilterAll}
                        </button>
                        <button
                            class="rounded-md px-2.5 py-1 transition-colors {fileFilter === 'image' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => fileFilter = 'image'}
                        >
                            {language.storageFilterImages}
                        </button>
                        <button
                            class="rounded-md px-2.5 py-1 transition-colors {fileFilter === 'audio' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => fileFilter = 'audio'}
                        >
                            {language.storageFilterAudio}
                        </button>
                        <button
                            class="rounded-md px-2.5 py-1 transition-colors {fileFilter === 'orphan' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => fileFilter = 'orphan'}
                        >
                            {language.storageFilterOrphan} ({orphanAssets.length})
                        </button>
                    </div>

                    {#if selectedFileKeys.size > 0}
                        <button
                            class="flex items-center gap-1.5 rounded-lg bg-rose-500/20 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors"
                            onclick={deleteSelectedFiles}
                        >
                            <Trash2Icon class="h-4 w-4" />
                            <span>{language.storageDeleteSelected} ({selectedFileKeys.size})</span>
                        </button>
                    {/if}
                </div>

                <!-- Files Table -->
                <div class="rounded-xl border border-darkborderc bg-darkbg overflow-hidden">
                    <div class="max-h-[600px] overflow-y-auto">
                        <table class="w-full text-left text-xs text-textcolor">
                            <thead class="sticky top-0 z-10 border-b border-darkborderc bg-darkbg/95 backdrop-blur-xs font-semibold text-textcolor2">
                                <tr>
                                    <th class="w-10 px-3 py-2.5 text-center">
                                        <input
                                            type="checkbox"
                                            checked={filteredFiles().length > 0 && selectedFileKeys.size === filteredFiles().length}
                                            onchange={toggleSelectAllFiles}
                                            class="rounded-sm border-darkborderc"
                                        />
                                    </th>
                                    <th class="px-3 py-2.5">미리보기</th>
                                    <th class="px-3 py-2.5">에셋 키 / 파일명</th>
                                    <th class="px-3 py-2.5 text-right">용량</th>
                                    <th class="px-3 py-2.5 text-center">작업</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-darkborderc/40">
                                {#if filteredFiles().length === 0}
                                    <tr>
                                        <td colspan="5" class="py-12 text-center text-textcolor2">
                                            {language.storageNoAssetsFound}
                                        </td>
                                    </tr>
                                {:else}
                                    {#each filteredFiles() as file (file.key)}
                                        <tr class="hover:bg-darkbutton/30 transition-colors {selectedFileKeys.has(file.key) ? 'bg-blue-500/10' : ''}">
                                            <td class="px-3 py-2 text-center">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedFileKeys.has(file.key)}
                                                    onchange={() => toggleSelectFile(file.key)}
                                                    class="rounded-sm border-darkborderc"
                                                />
                                            </td>
                                            <td class="px-3 py-2">
                                                <button
                                                    type="button"
                                                    class="h-8 w-8 overflow-hidden rounded-md border border-darkborderc bg-darkbutton hover:opacity-80 transition-opacity"
                                                    onclick={() => openPreview(file.key)}
                                                    title="Preview image"
                                                >
                                                    {#if /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.key)}
                                                        {@const _ = loadThumbnail(file.key)}
                                                        {#if thumbnailUrls.has(file.key)}
                                                            <img src={thumbnailUrls.get(file.key)} alt="" class="h-full w-full object-cover" />
                                                        {:else}
                                                            <div class="flex h-full w-full items-center justify-center text-[9px] text-textcolor2">img</div>
                                                        {/if}
                                                    {:else if /\.(mp3|wav|ogg|flac|aac)$/i.test(file.key)}
                                                        <div class="flex h-full w-full items-center justify-center text-textcolor2">
                                                            <MusicIcon class="h-4 w-4" />
                                                        </div>
                                                    {:else}
                                                        <div class="flex h-full w-full items-center justify-center text-textcolor2">
                                                            <LayersIcon class="h-4 w-4" />
                                                        </div>
                                                    {/if}
                                                </button>
                                            </td>
                                            <td class="px-3 py-2 font-mono text-xs max-w-xs truncate">
                                                <span title={file.key}>{file.key}</span>
                                            </td>
                                            <td class="px-3 py-2 text-right font-medium">
                                                {formatBytes(file.size)}
                                            </td>
                                            <td class="px-3 py-2 text-center">
                                                <button
                                                    class="rounded-md p-1 text-textcolor2 hover:bg-rose-500/20 hover:text-rose-300 transition-colors"
                                                    title="Delete"
                                                    onclick={async () => {
                                                        if (await alertConfirm(`Delete ${file.key}?`)) {
                                                            const storage = getNodeStorage()
                                                            await storage.s3.deleteAssetKeys([file.key], viewTarget)
                                                            await loadData()
                                                        }
                                                    }}
                                                >
                                                    <Trash2Icon class="h-3.5 w-3.5" />
                                                </button>
                                            </td>
                                        </tr>
                                    {/each}
                                {/if}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        {/if}
    </main>
</div>

<!-- BOT ASSET INSPECTOR MODAL / DRAWER -->
{#if selectedBot}
    <div class="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-200">
        <div class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-darkborderc bg-darkbg text-textcolor shadow-2xl overflow-hidden">
            <!-- Modal Header -->
            <div class="flex items-center justify-between border-b border-darkborderc px-5 py-3.5">
                <div class="flex items-center gap-3">
                    <div class="relative h-10 w-10 overflow-hidden rounded-lg border border-darkborderc bg-darkbutton">
                        {#if selectedBot.avatarKey}
                            {@const _ = loadThumbnail(selectedBot.avatarKey)}
                            {#if thumbnailUrls.has(selectedBot.avatarKey)}
                                <img src={thumbnailUrls.get(selectedBot.avatarKey)} alt="" class="h-full w-full object-cover" />
                            {/if}
                        {/if}
                    </div>
                    <div>
                        <h3 class="text-base font-bold">{selectedBot.name}</h3>
                        <div class="flex items-center gap-2 text-xs text-textcolor2">
                            <span>총 {selectedBot.totalAssets}개 에셋</span>
                            <span>·</span>
                            <span class="font-semibold text-blue-400">{formatBytes(selectedBot.totalSizeBytes)}</span>
                        </div>
                    </div>
                </div>
                <button
                    class="rounded-lg p-1.5 text-textcolor2 hover:bg-darkborderc/50 hover:text-textcolor"
                    onclick={() => selectedBot = null}
                >
                    <XIcon class="h-5 w-5" />
                </button>
            </div>

            <!-- Modal Body (Assets Grid) -->
            <div class="flex-1 overflow-y-auto p-5">
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {#each selectedBot.assets as asset (asset.key)}
                        <div class="flex items-center gap-3 rounded-xl border border-darkborderc bg-bgcolor/40 p-2.5">
                            <!-- Thumbnail / Icon -->
                            <button
                                type="button"
                                class="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-darkborderc bg-darkbutton hover:opacity-80 transition-opacity"
                                onclick={() => openPreview(asset.key)}
                                title="Preview image"
                            >
                                {#if /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(asset.key)}
                                    {@const _ = loadThumbnail(asset.key)}
                                    {#if thumbnailUrls.has(asset.key)}
                                        <img src={thumbnailUrls.get(asset.key)} alt="" class="h-full w-full object-cover" />
                                    {:else}
                                        <div class="flex h-full w-full items-center justify-center text-xs text-textcolor2">img</div>
                                    {/if}
                                {:else}
                                    <div class="flex h-full w-full items-center justify-center text-textcolor2">
                                        <MusicIcon class="h-5 w-5" />
                                    </div>
                                {/if}
                            </button>

                            <!-- Label & Info -->
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between">
                                    <span class="rounded-md bg-darkbutton px-1.5 py-0.5 text-[10px] font-medium text-textcolor2">
                                        {asset.type}
                                    </span>
                                    <span class="text-xs font-semibold text-blue-300">
                                        {formatBytes(asset.size)}
                                    </span>
                                </div>
                                <h5 class="mt-1 truncate text-xs font-medium text-textcolor" title={asset.label}>
                                    {asset.label}
                                </h5>
                                <div class="truncate text-[10px] text-textcolor2/70 font-mono" title={asset.key}>
                                    {asset.key}
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
            </div>

            <!-- Modal Footer -->
            <div class="flex justify-end border-t border-darkborderc px-5 py-3 bg-darkbg/50">
                <Button onclick={() => selectedBot = null}>닫기</Button>
            </div>
        </div>
    </div>
{/if}

<!-- LIGHTBOX IMAGE PREVIEW MODAL -->
{#if previewAssetKey}
    <div
        class="fixed inset-0 z-70 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md animate-in fade-in duration-150"
    >
        <div class="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl border border-darkborderc bg-darkbg p-2 shadow-2xl">
            <button
                class="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors"
                onclick={closePreview}
            >
                <XIcon class="h-4 w-4" />
            </button>
            {#if previewImageUrl}
                <img src={previewImageUrl} alt={previewAssetKey} class="max-h-[80vh] max-w-[85vw] object-contain rounded-lg" />
            {:else}
                <div class="p-12 text-center text-sm text-textcolor2">Loading preview...</div>
            {/if}
            <div class="mt-2 truncate px-2 text-center font-mono text-xs text-textcolor2">
                {previewAssetKey}
            </div>
        </div>
    </div>
{/if}

<!-- REAL-TIME FLOATING PROGRESS HUD -->
{#if activeTask && progressData}
    <div class="fixed bottom-4 left-4 right-4 z-60 md:left-auto md:right-6 md:w-96 rounded-xl border border-darkborderc bg-darkbg/95 p-4 text-textcolor shadow-2xl backdrop-blur-md transition-all duration-300">
        <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
                <svg class="h-4 w-4 animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <h5 class="text-sm font-semibold">
                    {activeTask === 'migrate' ? language.s3MigratingTitle : language.s3RollingBackTitle}
                </h5>
            </div>
            <span class="text-sm font-bold text-blue-400">
                {progressData.percentage}%
            </span>
        </div>

        <!-- Progress bar track -->
        <div class="mt-3 h-2.5 w-full overflow-hidden rounded-full border border-darkborderc bg-bgcolor/50">
            <div
                class="h-full bg-linear-to-r from-blue-500 via-indigo-500 to-purple-600 transition-[width] duration-150"
                style="width: {progressData.percentage}%"
            ></div>
        </div>

        <!-- Details -->
        <div class="mt-2.5 flex items-center justify-between text-xs text-textcolor2">
            <div>
                {progressData.current.toLocaleString()} / {progressData.total.toLocaleString()} 파일
            </div>
            {#if activeTask === 'migrate'}
                <div>
                    업로드: <span class="font-medium text-textcolor">{progressData.migrated ?? 0}</span> · 건너뜀: <span class="font-medium text-textcolor">{progressData.skipped ?? 0}</span>
                </div>
            {:else}
                <div>
                    다운로드: <span class="font-medium text-textcolor">{progressData.downloaded ?? 0}</span>
                </div>
            {/if}
        </div>

        {#if progressData.currentKey}
            <div class="mt-1 truncate text-[11px] text-textcolor2/70" title={progressData.currentKey}>
                {progressData.currentKey}
            </div>
        {/if}
    </div>
{/if}
