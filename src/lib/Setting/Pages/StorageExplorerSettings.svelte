<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import { CircleAlertIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
    import { getMimeType } from 'src/ts/media'
    import StorageExplorerHeader from './StorageExplorer/StorageExplorerHeader.svelte'
    import StorageOverviewBanner from './StorageExplorer/StorageOverviewBanner.svelte'
    import StorageTabNav from './StorageExplorer/StorageTabNav.svelte'
    import BotAnalysisTab from './StorageExplorer/tabs/BotAnalysisTab.svelte'
    import ModuleAnalysisTab from './StorageExplorer/tabs/ModuleAnalysisTab.svelte'
    import BackendConfigTab from './StorageExplorer/tabs/BackendConfigTab.svelte'
    import FilesExplorerTab from './StorageExplorer/tabs/FilesExplorerTab.svelte'
    import BotInspectorModal from './StorageExplorer/modals/BotInspectorModal.svelte'
    import ModuleInspectorModal from './StorageExplorer/modals/ModuleInspectorModal.svelte'
    import FilePreviewModal from './StorageExplorer/modals/FilePreviewModal.svelte'
    import StorageProgressHud from './StorageExplorer/components/StorageProgressHud.svelte'
    import {
        formatBytes,
        generateKeyCandidates,
        getNodeStorage,
        readImageFromTarget,
        runStorageAnalysis
    } from './StorageExplorer/utils'
    import type {
        AssetStorageType,
        BotStorageInfo,
        ModuleStorageInfo,
        NodeS3ProgressEvent,
        NodeS3ServerConfig,
        NodeStorageAssetDetails,
        NodeStorageAssetItem,
        NodeStorageSummary,
        TabType,
        ViewTarget
    } from './StorageExplorer/types'

    interface Props {
        close?: () => void
    }

    const { close = () => {} }: Props = $props()

    let currentTab = $state<TabType>('bots')
    let viewTarget = $state<ViewTarget>('s3')

    let loading = $state(true)
    let busy = $state(false)
    let loadError = $state('')

    // Storage summary (all storages)
    let storageSummary = $state<NodeStorageSummary | null>(null)

    // Backend config
    let config = $state<NodeS3ServerConfig | null>(null)
    let enabled = $state(false)
    let storageType = $state<AssetStorageType>('fs')
    let endpoint = $state('')
    let bucket = $state('risuai-assets')
    let region = $state('us-east-1')
    let accessKeyId = $state('')
    let secretAccessKey = $state('')
    let forcePathStyle = $state(true)
    let autoCreateBucket = $state(true)
    let testingConnection = $state(false)

    // Azure SQL fields
    let azureServer = $state('')
    let azureDatabase = $state('')
    let azureUser = $state('')
    let azurePassword = $state('')
    let azurePort = $state('1433')

    // Tasks & Migration
    let migrating = $state(false)
    let rollingBack = $state(false)
    let purgingLocal = $state(false)
    let cleaningOrphans = $state(false)
    let activeTask = $state<'migrate' | 'rollback' | null>(null)
    let progressData = $state<NodeS3ProgressEvent | null>(null)

    // Target asset details
    let assetDetails = $state<NodeStorageAssetDetails | null>(null)
    let assetMap = $state<Map<string, NodeStorageAssetItem>>(new Map())

    // Analyzed bot and module data
    let botAnalysis = $state<BotStorageInfo[]>([])
    let moduleAnalysis = $state<ModuleStorageInfo[]>([])
    let orphanAssets = $state<NodeStorageAssetItem[]>([])
    let orphanSizeBytes = $state(0)

    // Modals state
    let selectedBot = $state<BotStorageInfo | null>(null)
    let selectedModule = $state<ModuleStorageInfo | null>(null)
    let previewAssetKey = $state<string | null>(null)
    let previewImageUrl = $state<string | null>(null)

    // SQL asset catalog sync
    let resyncingCatalog = $state(false)

    // File selection
    let selectedFileKeys = $state<Set<string>>(new Set())

    // Thumbnail cache
    let thumbnailUrls = $state<Map<string, string>>(new Map())

    function clearThumbnailCache() {
        for (const url of thumbnailUrls.values()) {
            URL.revokeObjectURL(url)
        }
        thumbnailUrls = new Map()
    }

    async function loadData() {
        loading = true
        loadError = ''
        try {
            const storage = getNodeStorage()

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

                const active = config.storageType
                if (active === 'azuresql') {
                    viewTarget = 'azuresql'
                } else if (active === 's3') {
                    viewTarget = 's3'
                } else if (viewTarget === 's3' && !config.enabled) {
                    viewTarget = 'fs'
                }
            } catch {
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

    async function loadTargetAssets(promptForEmptyCatalog = true) {
        try {
            const storage = getNodeStorage()
            assetDetails = await storage.s3.getAssetDetails(viewTarget)

            if (viewTarget === 's3' && assetDetails.catalogEmpty && promptForEmptyCatalog) {
                const shouldPopulate = await alertConfirm(language.storageEmptyCatalogConfirm)
                if (shouldPopulate) {
                    resyncingCatalog = true
                    try {
                        const result = await storage.s3.resyncAssetCatalog()
                        alertNormal(language.storageResyncCatalogSuccess(result.count))
                        await loadTargetAssets(false)
                        return
                    } catch (error) {
                        alertError(error)
                    } finally {
                        resyncingCatalog = false
                    }
                }
            }

            const map = new Map<string, NodeStorageAssetItem>()
            for (const item of assetDetails.assets) {
                map.set(item.key, item)
            }
            assetMap = map

            const result = await runStorageAnalysis(assetMap, assetDetails)
            botAnalysis = result.bots
            moduleAnalysis = result.modules
            orphanAssets = result.orphanAssets
            orphanSizeBytes = result.orphanSizeBytes

            // Preload avatars
            for (const bot of result.bots) {
                if (bot.avatarKey) loadThumbnail(bot.avatarKey).catch(() => {})
            }
            for (const mod of result.modules) {
                if (mod.iconKey) loadThumbnail(mod.iconKey).catch(() => {})
            }
        } catch (err: any) {
            console.warn('Failed to load asset details for target:', viewTarget, err)
            assetDetails = {
                storageType: viewTarget,
                totalObjects: 0,
                totalSizeBytes: 0,
                assets: []
            }
            assetMap = new Map()
            const result = await runStorageAnalysis(assetMap, assetDetails)
            botAnalysis = result.bots
            moduleAnalysis = result.modules
            orphanAssets = result.orphanAssets
            orphanSizeBytes = result.orphanSizeBytes
        }
    }

    async function switchViewTarget(target: ViewTarget) {
        if (viewTarget === target) return
        viewTarget = target
        loading = true
        selectedFileKeys.clear()
        selectedFileKeys = new Set(selectedFileKeys)
        clearThumbnailCache()
        await loadTargetAssets()
        loading = false
    }

    async function loadThumbnail(key: string) {
        if (!key || thumbnailUrls.has(key)) return
        const candidates = generateKeyCandidates(key)

        for (const candidate of candidates) {
            try {
                const data = await readImageFromTarget(candidate, viewTarget)
                if (data && data.length > 0) {
                    const blob = new Blob([data as unknown as BlobPart], { type: getMimeType(candidate) })
                    const url = URL.createObjectURL(blob)
                    thumbnailUrls.set(key, url)
                    thumbnailUrls = new Map(thumbnailUrls)
                    return
                }
            } catch {
                // Next candidate
            }
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
                    azurePassword,
                    azurePort: parseInt(azurePort, 10) || 1433
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
                    azurePort: parseInt(azurePort, 10) || 1433
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
                await storage.s3.configureServer({
                    enabled: false,
                    storageType: 'fs'
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
            const keysToDelete = orphanAssets.map((a) => a.key)
            const result = await storage.s3.deleteAssetKeys(keysToDelete, viewTarget)
            alertNormal(language.storageCleanOrphanSuccess(result.deleted, formattedSize))
            await loadData()
        } catch (error) {
            alertError(error)
        } finally {
            cleaningOrphans = false
        }
    }

    async function resyncAssetCatalog() {
        if (resyncingCatalog || viewTarget !== 's3') return
        if (!await alertConfirm(language.storageResyncCatalogConfirm)) return

        resyncingCatalog = true
        try {
            const storage = getNodeStorage()
            const result = await storage.s3.resyncAssetCatalog()
            alertNormal(language.storageResyncCatalogSuccess(result.count))
            await loadTargetAssets()
        } catch (error) {
            alertError(error)
        } finally {
            resyncingCatalog = false
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

    async function deleteSingleFile(key: string) {
        if (await alertConfirm(language.storageDeleteConfirm(1))) {
            busy = true
            try {
                const storage = getNodeStorage()
                await storage.s3.deleteAssetKeys([key], viewTarget)
                selectedFileKeys.delete(key)
                selectedFileKeys = new Set(selectedFileKeys)
                await loadData()
            } catch (error) {
                alertError(error)
            } finally {
                busy = false
            }
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

    function toggleSelectAll(currentList: NodeStorageAssetItem[]) {
        if (selectedFileKeys.size === currentList.length && currentList.length > 0) {
            selectedFileKeys.clear()
        } else {
            selectedFileKeys = new Set(currentList.map((f) => f.key))
        }
    }

    async function openPreview(key: string) {
        previewAssetKey = key
        try {
            const data = await readImageFromTarget(key, viewTarget)
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

    onDestroy(() => {
        clearThumbnailCache()
        if (previewImageUrl) {
            URL.revokeObjectURL(previewImageUrl)
        }
    })
</script>

<svelte:window
    onkeydown={(e) => {
        if (e.key === 'Escape') {
            if (previewAssetKey) {
                closePreview()
            } else if (selectedBot) {
                selectedBot = null
            } else if (selectedModule) {
                selectedModule = null
            } else {
                close()
            }
        }
    }}
/>

<!-- Desktop Backdrop Overlay / Mobile Full-Screen Container -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4 md:p-6 lg:p-8 animate-in fade-in duration-200"
    onclick={close}
>
    <!-- Floating Window (Desktop) / Fullscreen (Mobile) -->
    <div
        class="flex h-full w-full sm:h-[92vh] sm:max-h-[960px] sm:max-w-6xl md:max-w-7xl lg:max-w-[105rem] flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-darkborderc bg-bgcolor text-textcolor shadow-2xl animate-in zoom-in-95 duration-200"
        onclick={(e) => e.stopPropagation()}
    >
        <!-- Header with Target Storage Switcher -->
        <StorageExplorerHeader
            {viewTarget}
            {config}
            {storageSummary}
            {loading}
            {busy}
            onSwitchTarget={switchViewTarget}
            onRefresh={loadData}
            onClose={close}
        />

        <!-- Storage Overview Summary Banner -->
        <StorageOverviewBanner
            {storageSummary}
            {config}
            {viewTarget}
            botCount={botAnalysis.length}
            moduleCount={moduleAnalysis.length}
            orphanCount={orphanAssets.length}
            {orphanSizeBytes}
            {purgingLocal}
            {cleaningOrphans}
            {busy}
            onPurgeLocalFs={purgeLocalFsAssets}
            onCleanOrphans={cleanOrphanAssets}
        />

        <!-- Tab Navigation Bar -->
        <StorageTabNav
            {currentTab}
            {viewTarget}
            botCount={botAnalysis.length}
            moduleCount={moduleAnalysis.length}
            fileCount={assetDetails?.totalObjects ?? 0}
            onSelectTab={(t) => currentTab = t}
        />

        <!-- Main Content Area -->
        <main class="flex-1 overflow-y-auto p-3 sm:p-5 min-h-0">
            {#if loadError}
                <div class="mb-4 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
                    <CircleAlertIcon class="h-5 w-5 shrink-0" />
                    <span>{loadError}</span>
                </div>
            {/if}

            <!-- TAB 1: BOTS -->
            {#if currentTab === 'bots'}
                <BotAnalysisTab
                    bots={botAnalysis}
                    {thumbnailUrls}
                    onLoadThumbnail={loadThumbnail}
                    onSelectBot={(bot) => selectedBot = bot}
                />
            {/if}

            <!-- TAB 2: MODULES -->
            {#if currentTab === 'modules'}
                <ModuleAnalysisTab
                    modules={moduleAnalysis}
                    {thumbnailUrls}
                    onLoadThumbnail={loadThumbnail}
                    onSelectModule={(mod) => selectedModule = mod}
                />
            {/if}

            <!-- TAB 3: BACKEND CONFIG -->
            {#if currentTab === 'backend'}
                <BackendConfigTab
                    {config}
                    {storageSummary}
                    {storageType}
                    bind:endpoint
                    bind:bucket
                    bind:region
                    bind:accessKeyId
                    bind:secretAccessKey
                    bind:forcePathStyle
                    bind:autoCreateBucket
                    bind:azureServer
                    bind:azureDatabase
                    bind:azureUser
                    bind:azurePassword
                    bind:azurePort
                    {busy}
                    {testingConnection}
                    {migrating}
                    {rollingBack}
                    {purgingLocal}
                    onSelectBackend={(type) => {
                        storageType = type
                        enabled = type !== 'fs'
                    }}
                    onTestConnection={testConnection}
                    onApplyConfiguration={applyConfiguration}
                    onMigrateToS3={migrateToS3}
                    onRollbackToLocal={rollbackToLocal}
                    onPurgeLocalFs={purgeLocalFsAssets}
                />
            {/if}

            <!-- TAB 4: ALL FILES EXPLORER -->
            {#if currentTab === 'files'}
                <FilesExplorerTab
                    {assetDetails}
                    {orphanAssets}
                    {viewTarget}
                    {selectedFileKeys}
                    {resyncingCatalog}
                    {busy}
                    {thumbnailUrls}
                    onLoadThumbnail={loadThumbnail}
                    onOpenPreview={openPreview}
                    onToggleSelectFile={toggleSelectFile}
                    onToggleSelectAll={toggleSelectAll}
                    onDeleteSingleFile={deleteSingleFile}
                    onDeleteSelectedFiles={deleteSelectedFiles}
                    onResyncCatalog={resyncAssetCatalog}
                />
            {/if}
        </main>
    </div>
</div>

<!-- BOT ASSET INSPECTOR MODAL -->
{#if selectedBot}
    <BotInspectorModal
        bot={selectedBot}
        {thumbnailUrls}
        onLoadThumbnail={loadThumbnail}
        onOpenPreview={openPreview}
        onClose={() => selectedBot = null}
    />
{/if}

<!-- MODULE ASSET INSPECTOR MODAL -->
{#if selectedModule}
    <ModuleInspectorModal
        module={selectedModule}
        {thumbnailUrls}
        onLoadThumbnail={loadThumbnail}
        onOpenPreview={openPreview}
        onClose={() => selectedModule = null}
    />
{/if}

<!-- LIGHTBOX IMAGE PREVIEW MODAL -->
<FilePreviewModal
    assetKey={previewAssetKey}
    imageUrl={previewImageUrl}
    onClose={closePreview}
/>

<!-- REAL-TIME FLOATING PROGRESS HUD -->
<StorageProgressHud
    {activeTask}
    {progressData}
/>
