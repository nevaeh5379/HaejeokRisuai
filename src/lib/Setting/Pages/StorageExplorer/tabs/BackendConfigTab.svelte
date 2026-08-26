<script lang="ts">
    import { onMount } from 'svelte'
    import {
        AlertCircleIcon,
        ArrowRightLeftIcon,
        CheckCircle2Icon,
        CheckIcon,
        CircleQuestionMarkIcon,
        ClockIcon,
        DatabaseIcon,
        DownloadIcon,
        FolderArchiveIcon,
        HardDriveIcon,
        InfoIcon,
        LayersIcon,
        RefreshCwIcon,
        ServerIcon,
        ShieldAlertIcon,
        ShieldCheckIcon,
        ShieldIcon,
        Trash2Icon,
        UploadIcon,
        ZapIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
    import type { NodeVectorCacheStats } from 'src/ts/storage/nodeStorage'
    import { formatBytes, getNodeStorage } from '../utils'
    import {
        buildSqlVendorParams,
        isSqlVendorParamsComplete,
        type DbVendor,
        type NodeBackupConfig,
        type NodeBackupProgressEvent,
        type SqlVendorFormValues
    } from 'src/ts/storage/nodePostgresStorage'
    import type { AssetStorageType, NodeS3ServerConfig, NodeStorageSummary } from '../types'

    interface Props {
        config: NodeS3ServerConfig | null
        storageSummary: NodeStorageSummary | null
        storageType: AssetStorageType
        endpoint: string
        bucket: string
        region: string
        accessKeyId: string
        secretAccessKey: string
        forcePathStyle: boolean
        autoCreateBucket: boolean
        azureServer: string
        azureDatabase: string
        azureUser: string
        azurePassword: string
        azurePort: string
        busy: boolean
        testingConnection: boolean
        migrating: boolean
        rollingBack: boolean
        purgingLocal: boolean
        backupConfig?: NodeBackupConfig | null
        initialSection?: 'assets' | 'backup'
        onSelectBackend: (type: AssetStorageType) => void
        onTestConnection: () => void
        onApplyConfiguration: () => void
        onMigrateToS3: () => void
        onRollbackToLocal: () => void
        onPurgeLocalFs: () => void
        onBackupUpdated?: () => void
    }

    let {
        config,
        storageSummary,
        storageType,
        endpoint = $bindable(),
        bucket = $bindable(),
        region = $bindable(),
        accessKeyId = $bindable(),
        secretAccessKey = $bindable(),
        forcePathStyle = $bindable(),
        autoCreateBucket = $bindable(),
        azureServer = $bindable(),
        azureDatabase = $bindable(),
        azureUser = $bindable(),
        azurePassword = $bindable(),
        azurePort = $bindable(),
        busy,
        testingConnection,
        migrating,
        rollingBack,
        purgingLocal,
        backupConfig = null,
        initialSection = 'assets',
        onSelectBackend,
        onTestConnection,
        onApplyConfiguration,
        onMigrateToS3,
        onRollbackToLocal,
        onPurgeLocalFs,
        onBackupUpdated
    }: Props = $props()

    let activeSection = $state<'assets' | 'backup' | 'cache'>('assets')

    let vectorCache = $state<NodeVectorCacheStats | null>(null)
    let vectorCacheLoading = $state(false)
    let vectorCacheClearing = $state(false)
    let vectorCacheError = $state('')

    // ── Backup DB Local States ──
    let localBackup = $state<NodeBackupConfig | null>(null)
    let backupLoadError = $state('')
    let backupTesting = $state(false)
    let backupResyncing = $state(false)
    let backupRestoring = $state(false)
    let backupRemoving = $state(false)
    let backupApplying = $state(false)
    let backupProgressData = $state<NodeBackupProgressEvent | null>(null)

    $effect(() => {
        if (initialSection) {
            activeSection = initialSection
        }
    })

    $effect(() => {
        if (backupConfig) {
            localBackup = backupConfig
            if (backupConfig.configured && backupConfig.vendor) {
                backupVendor = backupConfig.vendor
                const p = backupConfig.params || {}
                backupPgConnectionString = p.connectionString || ''
                backupPoolMax = p.poolMax || 10
                if (backupConfig.vendor === 'oracle') {
                    backupOracleUser = p.user || ''
                    backupOracleTnsAlias = p.tnsAlias || ''
                    backupOracleWalletPath = p.walletPath || ''
                } else if (backupConfig.vendor === 'azure') {
                    backupAzureHost = p.server || ''
                    backupAzureDatabase = p.database || ''
                    backupAzureUsername = p.user || ''
                    backupAzurePort = p.port || 1433
                }
                backupMirroring = Boolean(backupConfig.mirroring?.enabled)
                backupSnapshotEnabled = Boolean(backupConfig.snapshot?.enabled)
                backupSnapshotInterval = backupConfig.snapshot?.intervalMinutes || 60
            }
        }
    })

    let backupVendor = $state<DbVendor>('postgres')
    let backupPgConnectionString = $state('')
    let backupOracleUser = $state('')
    let backupOraclePassword = $state('')
    let backupOracleTnsAlias = $state('')
    let backupOracleWalletPath = $state('')
    let backupOracleWalletPassword = $state('')
    let backupAzureHost = $state('')
    let backupAzureDatabase = $state('')
    let backupAzureUsername = $state('')
    let backupAzurePassword = $state('')
    let backupAzurePort = $state(1433)
    let backupPoolMax = $state(10)
    let backupMirroring = $state(true)
    let backupSnapshotEnabled = $state(false)
    let backupSnapshotInterval = $state(60)

    function getBackupFormValues(vendor: DbVendor): SqlVendorFormValues {
        return {
            connectionString: backupPgConnectionString,
            server: backupAzureHost,
            database: backupAzureDatabase,
            user: vendor === 'oracle' ? backupOracleUser : backupAzureUsername,
            password: vendor === 'oracle' ? backupOraclePassword : backupAzurePassword,
            tnsAlias: backupOracleTnsAlias,
            walletPath: backupOracleWalletPath,
            walletPassword: backupOracleWalletPassword,
            port: backupAzurePort,
            poolMax: backupPoolMax
        }
    }

    function buildBackupParams(vendor: DbVendor): Record<string, unknown> {
        return buildSqlVendorParams(vendor, getBackupFormValues(vendor))
    }

    function isBackupParamsComplete(vendor: DbVendor): boolean {
        return isSqlVendorParamsComplete(vendor, getBackupFormValues(vendor))
    }

    async function refreshBackupStatus() {
        backupLoadError = ''
        try {
            const storage = getNodeStorage()
            localBackup = await storage.postgres.getBackupStatus()
            if (localBackup.configured && localBackup.vendor) {
                backupVendor = localBackup.vendor
                const p = localBackup.params || {}
                backupPgConnectionString = p.connectionString || ''
                backupPoolMax = p.poolMax || 10
                if (localBackup.vendor === 'oracle') {
                    backupOracleUser = p.user || ''
                    backupOracleTnsAlias = p.tnsAlias || ''
                    backupOracleWalletPath = p.walletPath || ''
                } else if (localBackup.vendor === 'azure') {
                    backupAzureHost = p.server || ''
                    backupAzureDatabase = p.database || ''
                    backupAzureUsername = p.user || ''
                    backupAzurePort = p.port || 1433
                }
                backupMirroring = Boolean(localBackup.mirroring?.enabled)
                backupSnapshotEnabled = Boolean(localBackup.snapshot?.enabled)
                backupSnapshotInterval = localBackup.snapshot?.intervalMinutes || 60
            }
            onBackupUpdated?.()
        } catch (error) {
            localBackup = null
            backupLoadError = `${error}`
        }
    }

    async function testBackupConnection() {
        if (!backupVendor) {
            alertError(language.sqlSelectVendorFirst)
            return
        }
        if (!isBackupParamsComplete(backupVendor)) {
            alertError(language.sqlConfigIncomplete)
            return
        }
        backupTesting = true
        try {
            const storage = getNodeStorage()
            const result = await storage.postgres.testBackupConnection(backupVendor, buildBackupParams(backupVendor))
            if (result.success) {
                alertNormal(language.sqlConnectionSuccess)
            } else {
                alertError(result.error || language.sqlConnectionFailed)
            }
        } catch (error) {
            alertError(error)
        } finally {
            backupTesting = false
        }
    }

    async function applyBackupConfiguration() {
        if (!backupVendor) {
            alertError(language.sqlSelectVendorFirst)
            return
        }
        if (!isBackupParamsComplete(backupVendor)) {
            alertError(language.sqlConfigIncomplete)
            return
        }
        if (!await alertConfirm(language.sqlBackupApplyConfirm)) {
            return
        }
        backupApplying = true
        try {
            const storage = getNodeStorage()
            localBackup = await storage.postgres.configureBackup({
                vendor: backupVendor,
                params: buildBackupParams(backupVendor),
                mirroring: { enabled: backupMirroring },
                snapshot: { enabled: backupSnapshotEnabled, intervalMinutes: backupSnapshotInterval }
            })
            alertNormal(language.sqlBackupApplySuccess)
            await refreshBackupStatus()
        } catch (error) {
            alertError(error)
        } finally {
            backupApplying = false
        }
    }

    async function resyncBackupNow() {
        if (!await alertConfirm(language.sqlBackupResyncConfirm)) {
            return
        }
        backupResyncing = true
        backupProgressData = {
            stage: 'reading',
            percentage: 5,
            message: language.sqlBackupProgressReading
        }
        try {
            const storage = getNodeStorage()
            await storage.postgres.resyncBackup((event) => {
                backupProgressData = event
            })
            alertNormal(language.sqlBackupResyncSuccess)
            await refreshBackupStatus()
        } catch (error) {
            alertError(error)
        } finally {
            backupResyncing = false
            setTimeout(() => {
                backupProgressData = null
            }, 1200)
        }
    }

    async function restoreFromBackupNow() {
        if (!await alertConfirm(language.sqlBackupRestoreToMainConfirm)) {
            return
        }
        backupRestoring = true
        backupProgressData = {
            stage: 'reading',
            percentage: 5,
            message: language.sqlBackupProgressRestoring
        }
        try {
            const storage = getNodeStorage()
            await storage.postgres.restoreFromBackup((event) => {
                backupProgressData = event
            })
            alertNormal(language.sqlBackupRestoreToMainSuccess)
            setTimeout(() => location.reload(), 500)
        } catch (error) {
            alertError(error)
            backupRestoring = false
            backupProgressData = null
        }
    }

    async function removeBackupConfiguration() {
        if (!await alertConfirm(language.sqlBackupRemoveConfirm)) {
            return
        }
        backupRemoving = true
        try {
            const storage = getNodeStorage()
            await storage.postgres.removeBackup()
            alertNormal(language.sqlBackupRemoveSuccess)
            localBackup = null
            await refreshBackupStatus()
        } catch (error) {
            alertError(error)
        } finally {
            backupRemoving = false
        }
    }

    function formatTime(value: string | null | undefined) {
        if (!value) return language.sqlBackupNever
        return new Date(value).toLocaleString()
    }

    function queryCacheHitRate() {
        if (!vectorCache) return 0
        const total = vectorCache.query.hits + vectorCache.query.misses
        return total > 0 ? Math.round((vectorCache.query.hits / total) * 100) : 0
    }

    async function refreshVectorCache() {
        if (vectorCacheLoading) return
        vectorCacheLoading = true
        vectorCacheError = ''
        try {
            vectorCache = await getNodeStorage().vectorCacheStats()
        } catch (error) {
            vectorCacheError = `${error}`
        } finally {
            vectorCacheLoading = false
        }
    }

    async function clearVectorCacheNow() {
        if (vectorCacheClearing || !await alertConfirm('현재 사용자의 서버 벡터/임베딩 캐시를 모두 비우시겠습니까? 필요할 때 자동으로 다시 생성됩니다.')) return
        vectorCacheClearing = true
        try {
            const cleared = await getNodeStorage().clearVectorCache()
            alertNormal(`벡터 캐시를 정리했습니다. 디스크 ${cleared.vector.diskIndexes}개, 메모리 ${cleared.vector.memoryIndexes}개, 쿼리 ${cleared.query.entries}개를 제거했습니다.`)
            await refreshVectorCache()
        } catch (error) {
            alertError(error)
        } finally {
            vectorCacheClearing = false
        }
    }

    onMount(() => {
        refreshBackupStatus()
        refreshVectorCache()
    })
</script>

<div class="w-full space-y-5 select-none">
    <!-- Sub-navigation Header: Asset Storage vs Backup Database -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-darkborderc pb-3">
        <div class="flex items-center gap-1.5 rounded-xl border border-darkborderc bg-darkbg p-1 text-xs">
            <button
                type="button"
                class="flex items-center gap-2 rounded-lg px-3.5 py-1.5 transition-all cursor-pointer {activeSection === 'assets' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => activeSection = 'assets'}
            >
                <HardDriveIcon class="h-4 w-4 shrink-0" />
                <span>{language.storageTabBackend}</span>
                {#if config}
                    <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] font-mono text-textcolor2 border border-darkborderc/40">
                        {config.storageType.toUpperCase()}
                    </span>
                {/if}
            </button>

            <button
                type="button"
                class="flex items-center gap-2 rounded-lg px-3.5 py-1.5 transition-all cursor-pointer {activeSection === 'backup' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => activeSection = 'backup'}
            >
                <ShieldCheckIcon class="h-4 w-4 shrink-0" />
                <span>{language.sqlBackupTitle}</span>
                {#if localBackup?.configured}
                    <span class="rounded-full px-1.5 py-0.2 text-[10px] font-mono shrink-0 {localBackup.enabled ? 'bg-darkbutton border border-darkborderc text-textcolor flex items-center gap-1' : 'bg-darkbutton text-textcolor2'}">
                        {#if localBackup.enabled}
                            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                        {/if}
                        {localBackup.enabled ? language.storageActive : language.storageInactive}
                    </span>
                {/if}
            </button>

            <button
                type="button"
                class="flex items-center gap-2 rounded-lg px-3.5 py-1.5 transition-all cursor-pointer {activeSection === 'cache' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => {
                    activeSection = 'cache'
                    refreshVectorCache()
                }}
            >
                <ZapIcon class="h-4 w-4 shrink-0" />
                <span>Vector Cache</span>
                {#if vectorCache}
                    <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] font-mono text-textcolor2 border border-darkborderc/40">
                        {vectorCache.vector.disk.indexes}
                    </span>
                {/if}
            </button>
        </div>
    </div>

    <!-- ══════════════════════════════════════════════════════════════ -->
    <!-- SECTION 1: ASSET STORAGE BACKEND                              -->
    <!-- ══════════════════════════════════════════════════════════════ -->
    {#if activeSection === 'assets'}
        <!-- Backend Selector: Segment Cards (Full Width) -->
        <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <h3 class="text-sm sm:text-base font-bold text-textcolor flex items-center gap-2">
                        <LayersIcon class="h-4.5 w-4.5 text-textcolor" />
                        <span>{language.storageBackendSelect}</span>
                    </h3>
                    <button
                        type="button"
                        class="text-textcolor2 hover:text-textcolor transition-colors cursor-pointer p-0.5"
                        title={language.storageBackendSelectDescription}
                        onclick={() => alertNormal(language.storageBackendSelectDescription)}
                        aria-label="도움말"
                    >
                        <CircleQuestionMarkIcon size={14} />
                    </button>
                </div>
            </div>

            {#if config?.managedByEnvironment}
                <div class="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200">
                    <AlertCircleIcon class="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
                    <span class="leading-relaxed">{language.s3EnvironmentManaged}</span>
                </div>
            {/if}

            <!-- Segment Cards Grid (3 Columns) -->
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-3.5">
                <!-- Local FS Card -->
                <button
                    type="button"
                    class="group relative flex items-center justify-between rounded-xl border p-3.5 sm:p-4 text-left transition-all duration-150 cursor-pointer {storageType === 'fs' ? 'border-indigo-500/50 bg-indigo-500/10 text-textcolor ring-1 ring-indigo-500/30 shadow-xs font-medium' : 'border-darkborderc bg-bgcolor/40 hover:border-indigo-500/30 hover:bg-darkbg text-textcolor2'} {config?.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => onSelectBackend('fs')}
                    disabled={config?.managedByEnvironment}
                    title={language.storageBackendFsDesc}
                >
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-indigo-400 border border-darkborderc">
                            <FolderArchiveIcon class="h-4.5 w-4.5" />
                        </div>
                        <div class="min-w-0">
                            <div class="text-xs sm:text-sm font-bold text-textcolor">{language.storageBackendLocalFs}</div>
                            <div class="text-[11px] text-textcolor2 truncate">서버 로컬 디스크</div>
                        </div>
                    </div>
                    {#if config?.storageType === 'fs'}
                        <span class="rounded-full bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-semibold text-indigo-300 shrink-0 flex items-center gap-1">
                            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                            {language.storageActive}
                        </span>
                    {/if}
                </button>

                <!-- S3 Card -->
                <button
                    type="button"
                    class="group relative flex items-center justify-between rounded-xl border p-3.5 sm:p-4 text-left transition-all duration-150 cursor-pointer {storageType === 's3' ? 'border-blue-500/50 bg-blue-500/10 text-textcolor ring-1 ring-blue-500/30 shadow-xs font-medium' : 'border-darkborderc bg-bgcolor/40 hover:border-blue-500/30 hover:bg-darkbg text-textcolor2'} {config?.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => onSelectBackend('s3')}
                    disabled={config?.managedByEnvironment}
                    title={language.storageBackendS3Desc}
                >
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-blue-400 border border-darkborderc">
                            <ServerIcon class="h-4.5 w-4.5" />
                        </div>
                        <div class="min-w-0">
                            <div class="text-xs sm:text-sm font-bold text-textcolor">{language.storageBackendS3}</div>
                            <div class="text-[11px] text-textcolor2 truncate">RustFS, MinIO, S3, R2</div>
                        </div>
                    </div>
                    {#if config?.storageType === 's3' && config?.enabled}
                        <span class="rounded-full bg-blue-500/15 border border-blue-500/30 px-2 py-0.5 text-[10px] font-semibold text-blue-300 shrink-0 flex items-center gap-1">
                            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                            {language.storageActive}
                        </span>
                    {/if}
                </button>

                <!-- Azure SQL Card -->
                <button
                    type="button"
                    class="group relative flex items-center justify-between rounded-xl border p-3.5 sm:p-4 text-left transition-all duration-150 cursor-pointer {storageType === 'azuresql' ? 'border-sky-500/50 bg-sky-500/10 text-textcolor ring-1 ring-sky-500/30 shadow-xs font-medium' : 'border-darkborderc bg-bgcolor/40 hover:border-sky-500/30 hover:bg-darkbg text-textcolor2'} {config?.azureManagedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => onSelectBackend('azuresql')}
                    disabled={config?.azureManagedByEnvironment}
                    title={language.storageBackendAzureSqlDesc}
                >
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-sky-400 border border-darkborderc">
                            <DatabaseIcon class="h-4.5 w-4.5" />
                        </div>
                        <div class="min-w-0">
                            <div class="text-xs sm:text-sm font-bold text-textcolor">{language.storageBackendAzureSql}</div>
                            <div class="text-[11px] text-textcolor2 truncate">Azure SQL / MSSQL Blob</div>
                        </div>
                    </div>
                    {#if config?.storageType === 'azuresql' && config?.enabled}
                        <span class="rounded-full bg-sky-500/15 border border-sky-500/30 px-2 py-0.5 text-[10px] font-semibold text-sky-300 shrink-0 flex items-center gap-1">
                            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                            {language.storageActive}
                        </span>
                    {/if}
                </button>
            </div>
        </div>

        <!-- 2-Column Responsive Layout: Connection Form & Tools (Desktop lg:grid-cols-12) -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
            <!-- Left Main Column: Connection Form (7 cols) -->
            <div class="lg:col-span-7 xl:col-span-7 space-y-5">
                <!-- S3 Config Form -->
                {#if storageType === 's3'}
                    <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs space-y-5">
                        <div class="flex items-center justify-between border-b border-darkborderc/60 pb-3">
                            <div class="flex items-center gap-2">
                                <h4 class="text-sm sm:text-base font-bold text-textcolor flex items-center gap-2">
                                    <ServerIcon class="h-4.5 w-4.5 text-blue-400" />
                                    <span>{language.storageConnectionSettings} (S3 / RustFS)</span>
                                </h4>
                                <button
                                    type="button"
                                    class="text-textcolor2 hover:text-textcolor transition-colors cursor-pointer p-0.5"
                                    title={language.s3StorageDescription}
                                    onclick={() => alertNormal(language.s3StorageDescription)}
                                    aria-label="도움말"
                                >
                                    <CircleQuestionMarkIcon size={14} />
                                </button>
                            </div>
                        </div>

                        <div class="space-y-4">
                            <!-- S3 Endpoint (Full Width) -->
                            <div>
                                <div class="flex items-center gap-1.5">
                                    <label class="block text-xs font-medium text-textcolor2" for="s3-endpoint">{language.s3Endpoint}</label>
                                    <button
                                        type="button"
                                        class="text-textcolor2/70 hover:text-textcolor transition-colors cursor-pointer"
                                        title={language.s3EndpointHint}
                                        onclick={() => alertNormal(language.s3EndpointHint)}
                                        aria-label="엔드포인트 도움말"
                                    >
                                        <CircleQuestionMarkIcon size={13} />
                                    </button>
                                </div>
                                <TextInput id="s3-endpoint" bind:value={endpoint} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="http://127.0.0.1:9000" className="mt-1 text-xs" />
                            </div>

                            <!-- Bucket Name & Region (2 Columns) -->
                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="s3-bucket">{language.s3Bucket}</label>
                                    <TextInput id="s3-bucket" bind:value={bucket} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="risuai-assets" className="mt-1 text-xs" />
                                </div>

                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="s3-region">{language.s3Region}</label>
                                    <TextInput id="s3-region" bind:value={region} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="us-east-1" className="mt-1 text-xs" />
                                </div>
                            </div>

                            <!-- Access Key & Secret Key (2 Columns) -->
                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="s3-access-key">{language.s3AccessKeyId}</label>
                                    <TextInput id="s3-access-key" bind:value={accessKeyId} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="rustfsadmin" className="mt-1 text-xs" />
                                </div>

                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="s3-secret-key">{language.s3SecretAccessKey}</label>
                                    <TextInput id="s3-secret-key" bind:value={secretAccessKey} hideText={true} fullwidth={true} disabled={config?.managedByEnvironment} placeholder={config?.hasSecretAccessKey ? '•••••••••••• (저장됨 / 변경 시 입력)' : 'rustfsadmin'} className="mt-1 text-xs" />
                                </div>
                            </div>
                        </div>

                        <!-- Checkbox Options -->
                        <div class="rounded-xl border border-darkborderc/80 bg-bgcolor/40 p-3.5 space-y-2.5 text-xs">
                            <div class="flex items-center gap-2">
                                <CheckInput bind:check={forcePathStyle} name={language.s3ForcePathStyle} />
                                <button
                                    type="button"
                                    class="text-textcolor2/70 hover:text-textcolor p-0.5 transition-colors cursor-pointer"
                                    title="RustFS, MinIO, 로컬 S3 에뮬레이터 환경에서 필수입니다."
                                    onclick={() => alertNormal('RustFS, MinIO, 로컬 S3 에뮬레이터 환경에서 필수입니다.')}
                                    aria-label="도움말"
                                >
                                    <CircleQuestionMarkIcon size={14} />
                                </button>
                            </div>
                            <div class="flex items-center gap-2 pt-2 border-t border-darkborderc/40">
                                <CheckInput bind:check={autoCreateBucket} name={language.s3AutoCreateBucket} />
                                <button
                                    type="button"
                                    class="text-textcolor2/70 hover:text-textcolor p-0.5 transition-colors cursor-pointer"
                                    title="버킷이 존재하지 않을 경우 첫 업로드 시 자동으로 생성합니다."
                                    onclick={() => alertNormal('버킷이 존재하지 않을 경우 첫 업로드 시 자동으로 생성합니다.')}
                                    aria-label="도움말"
                                >
                                    <CircleQuestionMarkIcon size={14} />
                                </button>
                            </div>
                        </div>

                        {#if !config?.managedByEnvironment}
                            <div class="flex flex-wrap items-center gap-2.5 pt-3 border-t border-darkborderc/60">
                                <Button disabled={busy || testingConnection} onclick={onTestConnection}>
                                    {testingConnection ? language.s3Testing : language.s3TestConnection}
                                </Button>

                                <Button className="bg-selected hover:opacity-90 font-medium" disabled={busy} onclick={onApplyConfiguration}>
                                    {busy ? language.s3Applying : language.s3Apply}
                                </Button>
                            </div>
                        {/if}
                    </div>
                {:else if storageType === 'azuresql'}
                    <!-- Azure SQL Form Fields -->
                    <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs space-y-5">
                        <div class="flex items-center justify-between border-b border-darkborderc/60 pb-3">
                            <div class="flex items-center gap-2">
                                <h4 class="text-sm sm:text-base font-bold text-textcolor flex items-center gap-2">
                                    <DatabaseIcon class="h-4.5 w-4.5 text-sky-400" />
                                    <span>{language.storageAzureSqlConnectionSettings}</span>
                                </h4>
                                <button
                                    type="button"
                                    class="text-textcolor2 hover:text-textcolor transition-colors cursor-pointer p-0.5"
                                    title={language.storageBackendAzureSqlDesc}
                                    onclick={() => alertNormal(language.storageBackendAzureSqlDesc)}
                                    aria-label="도움말"
                                >
                                    <CircleQuestionMarkIcon size={14} />
                                </button>
                            </div>
                        </div>

                        {#if config?.azureManagedByEnvironment}
                            <div class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200">
                                {language.azureSqlManagedByEnv}
                            </div>
                        {/if}

                        <div class="space-y-4">
                            <!-- Host & Port (2 Columns) -->
                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <div class="sm:col-span-2">
                                    <label class="block text-xs font-medium text-textcolor2" for="azure-server">{language.azureSqlHost}</label>
                                    <TextInput id="azure-server" bind:value={azureServer} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="your-server.database.windows.net" className="mt-1 text-xs" />
                                </div>

                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="azure-port">{language.azureSqlPort}</label>
                                    <TextInput id="azure-port" bind:value={azurePort} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="1433" className="mt-1 text-xs" />
                                </div>
                            </div>

                            <!-- Database Name (Full Width) -->
                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="azure-database">{language.azureSqlDatabase}</label>
                                <TextInput id="azure-database" bind:value={azureDatabase} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="risuai_assets" className="mt-1 text-xs" />
                            </div>

                            <!-- Username & Password (2 Columns) -->
                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="azure-user">{language.azureSqlUser}</label>
                                    <TextInput id="azure-user" bind:value={azureUser} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="admin" className="mt-1 text-xs" />
                                </div>

                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="azure-password">{language.azureSqlPassword}</label>
                                    <TextInput id="azure-password" bind:value={azurePassword} hideText={true} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder={config?.hasAzurePassword ? '•••••••••••• (저장됨 / 변경 시 입력)' : ''} className="mt-1 text-xs" />
                                </div>
                            </div>
                        </div>

                        {#if !config?.azureManagedByEnvironment}
                            <div class="flex flex-wrap items-center gap-2.5 pt-3 border-t border-darkborderc/60">
                                <Button disabled={busy || testingConnection} onclick={onTestConnection}>
                                    {testingConnection ? language.s3Testing : language.s3TestConnection}
                                </Button>

                                <Button className="bg-selected hover:opacity-90 font-medium" disabled={busy} onclick={onApplyConfiguration}>
                                    {busy ? language.s3Applying : language.s3Apply}
                                </Button>
                            </div>
                        {/if}
                    </div>
                {:else}
                    <!-- Local FS Info & Apply -->
                    <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs space-y-4">
                        <div class="flex items-center justify-between border-b border-darkborderc/60 pb-3">
                            <div class="flex items-center gap-2">
                                <h4 class="text-sm sm:text-base font-bold text-textcolor flex items-center gap-2">
                                    <FolderArchiveIcon class="h-4.5 w-4.5 text-indigo-400" />
                                    <span>{language.storageBackendLocalFs}</span>
                                </h4>
                                <button
                                    type="button"
                                    class="text-textcolor2 hover:text-textcolor transition-colors cursor-pointer p-0.5"
                                    title={language.storageBackendFsDesc}
                                    onclick={() => alertNormal(language.storageBackendFsDesc)}
                                    aria-label="도움말"
                                >
                                    <CircleQuestionMarkIcon size={14} />
                                </button>
                            </div>
                        </div>

                        <div class="rounded-xl border border-darkborderc bg-bgcolor/40 p-4 space-y-1.5 text-xs text-textcolor2">
                            <p class="font-medium text-textcolor">기본 로컬 디스크 저장소 모드</p>
                            <p class="text-[11px] leading-relaxed">별도의 외부 클라우드 설정 없이 서버 로컬 디스크(`data/assets`)에 미디어 에셋을 저장합니다.</p>
                        </div>

                        {#if !config?.managedByEnvironment}
                            <div class="pt-2">
                                <Button
                                    className="bg-selected hover:opacity-90 font-medium"
                                    disabled={busy || (!config?.enabled && config?.storageType === 'fs')}
                                    onclick={onApplyConfiguration}
                                >
                                    {busy ? language.s3Applying : language.s3Apply}
                                </Button>
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>

            <!-- Right Sidebar Column: Migration & Maintenance Tools (5 cols) -->
            <div class="lg:col-span-5 xl:col-span-5 space-y-5">
                <!-- Migration & Rollback Tools -->
                <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
                    <div class="flex items-center justify-between border-b border-darkborderc/60 pb-3">
                        <h4 class="text-sm font-bold text-textcolor flex items-center gap-2">
                            <ArrowRightLeftIcon class="h-4 w-4 text-textcolor" />
                            <span>{language.s3StatsAndTools}</span>
                        </h4>
                        <button
                            type="button"
                            class="text-textcolor2 hover:text-textcolor transition-colors cursor-pointer p-0.5"
                            title={language.s3StatsAndToolsDescription}
                            onclick={() => alertNormal(language.s3StatsAndToolsDescription)}
                            aria-label="도움말"
                        >
                            <CircleQuestionMarkIcon size={14} />
                        </button>
                    </div>

                    <div class="space-y-2.5">
                        <!-- Migration Action Item -->
                        <div class="flex items-center justify-between gap-3 rounded-xl border border-darkborderc/80 bg-bgcolor/40 p-3">
                            <div class="flex items-center gap-3 min-w-0">
                                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-textcolor border border-darkborderc">
                                    <UploadIcon class="h-4 w-4" />
                                </div>
                                <div class="min-w-0">
                                    <div class="text-xs font-bold text-textcolor">
                                        {config?.storageType === 'azuresql' ? language.azureSqlStorageMigrateFromLocal : language.s3MigrateFromLocal}
                                    </div>
                                    <div class="text-[11px] text-textcolor2 truncate">로컬 에셋을 외부 스토리지로 업로드</div>
                                </div>
                            </div>
                            <Button
                                size="sm"
                                disabled={migrating || !config?.enabled}
                                onclick={onMigrateToS3}
                                className="shrink-0 inline-flex items-center gap-1.5 font-medium"
                            >
                                {#if migrating}
                                    <RefreshCwIcon class="h-3.5 w-3.5 animate-spin" />
                                    <span>{language.s3Migrating}</span>
                                {:else}
                                    <UploadIcon class="h-3.5 w-3.5" />
                                    <span>{language.storageUpload}</span>
                                {/if}
                            </Button>
                        </div>

                        <!-- Rollback Action Item -->
                        <div class="flex items-center justify-between gap-3 rounded-xl border border-darkborderc/80 bg-bgcolor/40 p-3">
                            <div class="flex items-center gap-3 min-w-0">
                                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-textcolor border border-darkborderc">
                                    <DownloadIcon class="h-4 w-4" />
                                </div>
                                <div class="min-w-0">
                                    <div class="text-xs font-bold text-textcolor">
                                        {config?.storageType === 'azuresql' ? language.azureSqlStorageRollbackToLocal : language.s3RollbackToLocal}
                                    </div>
                                    <div class="text-[11px] text-textcolor2 truncate">외부 에셋을 로컬 디스크로 다운로드</div>
                                </div>
                            </div>
                            <Button
                                size="sm"
                                disabled={rollingBack || !config?.enabled}
                                onclick={onRollbackToLocal}
                                className="shrink-0 inline-flex items-center gap-1.5 font-medium"
                            >
                                {#if rollingBack}
                                    <RefreshCwIcon class="h-3.5 w-3.5 animate-spin" />
                                    <span>{language.s3RollingBack}</span>
                                {:else}
                                    <DownloadIcon class="h-3.5 w-3.5" />
                                    <span>{language.storageDownload}</span>
                                {/if}
                            </Button>
                        </div>

                        <!-- Purge Redundant Local Files (if applicable) -->
                        {#if config?.enabled && (storageSummary?.localFs?.totalObjects ?? 0) > 0}
                            <div class="flex items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
                                <div class="flex items-center gap-3 min-w-0">
                                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/40">
                                        <Trash2Icon class="h-4 w-4" />
                                    </div>
                                    <div class="min-w-0">
                                        <div class="text-xs font-bold text-rose-200">
                                            {language.storagePurgeLocalFs}
                                        </div>
                                        <div class="text-[11px] text-rose-300/80 truncate">
                                            중복 로컬 파일 {(storageSummary?.localFs?.totalObjects ?? 0).toLocaleString()}개 정리
                                        </div>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    className="shrink-0 inline-flex items-center gap-1.5 bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 border-rose-500/40 font-medium"
                                    disabled={purgingLocal || busy}
                                    onclick={onPurgeLocalFs}
                                >
                                    {#if purgingLocal}
                                        <RefreshCwIcon class="h-3.5 w-3.5 animate-spin" />
                                        <span>{language.storagePurging}</span>
                                    {:else}
                                        <Trash2Icon class="h-3.5 w-3.5" />
                                        <span>정리</span>
                                    {/if}
                                </Button>
                            </div>
                        {/if}
                    </div>
                </div>
            </div>
        </div>
    {/if}

    <!-- ══════════════════════════════════════════════════════════════ -->
    <!-- SECTION 2: VECTOR / EMBEDDING CACHE                          -->
    <!-- ══════════════════════════════════════════════════════════════ -->
    {#if activeSection === 'cache'}
        <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-5">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-darkborderc/60 pb-4">
                <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-darkbutton border border-darkborderc text-amber-300">
                        <ZapIcon class="h-5 w-5" />
                    </div>
                    <div>
                        <h3 class="text-sm sm:text-base font-bold text-textcolor">서버 벡터 캐시</h3>
                        <p class="mt-0.5 text-xs text-textcolor2">Hypa 검색용 문서 벡터와 반복 쿼리 임베딩의 현재 사용량을 확인합니다.</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-lg border border-darkborderc bg-darkbutton px-3 py-2 text-xs text-textcolor2 hover:text-textcolor disabled:opacity-50 cursor-pointer"
                        onclick={refreshVectorCache}
                        disabled={vectorCacheLoading || vectorCacheClearing}
                    >
                        <RefreshCwIcon class="h-3.5 w-3.5 {vectorCacheLoading ? 'animate-spin' : ''}" />
                        새로고침
                    </button>
                    <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-lg border border-draculared/40 bg-draculared/10 px-3 py-2 text-xs text-draculared hover:bg-draculared/15 disabled:opacity-50 cursor-pointer"
                        onclick={clearVectorCacheNow}
                        disabled={vectorCacheLoading || vectorCacheClearing}
                    >
                        <Trash2Icon class="h-3.5 w-3.5" />
                        {vectorCacheClearing ? '정리 중...' : '캐시 비우기'}
                    </button>
                </div>
            </div>

            {#if vectorCacheError}
                <div class="rounded-xl border border-draculared/40 bg-draculared/10 p-3 text-xs text-draculared">{vectorCacheError}</div>
            {:else if vectorCache}
                <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
                    <div class="rounded-xl border border-darkborderc bg-bgcolor/40 p-4 space-y-3">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-semibold text-textcolor">RAM Vector Index</span>
                            <span class="rounded-full bg-darkbutton px-2 py-0.5 text-[10px] font-mono text-textcolor2">{vectorCache.vector.memory.indexes} indexes</span>
                        </div>
                        <div class="text-2xl font-bold text-textcolor">{formatBytes(vectorCache.vector.memory.bytes)}</div>
                        <div class="grid grid-cols-2 gap-2 text-[11px] text-textcolor2">
                            <span>Vectors</span><span class="text-right font-mono text-textcolor">{vectorCache.vector.memory.vectors}</span>
                            <span>Global limit</span><span class="text-right font-mono text-textcolor">{formatBytes(vectorCache.vector.limits.memoryBytes)}</span>
                        </div>
                    </div>

                    <div class="rounded-xl border border-darkborderc bg-bgcolor/40 p-4 space-y-3">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-semibold text-textcolor">Persistent Vector Cache</span>
                            <span class="rounded-full bg-darkbutton px-2 py-0.5 text-[10px] font-mono text-textcolor2">{vectorCache.vector.disk.indexes} indexes</span>
                        </div>
                        <div class="text-2xl font-bold text-textcolor">{formatBytes(vectorCache.vector.disk.bytes)}</div>
                        <div class="grid grid-cols-2 gap-2 text-[11px] text-textcolor2">
                            <span>Vectors</span><span class="text-right font-mono text-textcolor">{vectorCache.vector.disk.vectors}</span>
                            <span>Disk limit</span><span class="text-right font-mono text-textcolor">{formatBytes(vectorCache.vector.limits.diskBytes)}</span>
                            <span>Pending writes</span><span class="text-right font-mono text-textcolor">{vectorCache.vector.disk.pendingWrites}</span>
                        </div>
                    </div>

                    <div class="rounded-xl border border-darkborderc bg-bgcolor/40 p-4 space-y-3">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-semibold text-textcolor">Query Embedding LRU</span>
                            <span class="rounded-full bg-darkbutton px-2 py-0.5 text-[10px] font-mono text-textcolor2">{queryCacheHitRate()}% hit</span>
                        </div>
                        <div class="text-2xl font-bold text-textcolor">{formatBytes(vectorCache.query.bytes)}</div>
                        <div class="grid grid-cols-2 gap-2 text-[11px] text-textcolor2">
                            <span>Entries</span><span class="text-right font-mono text-textcolor">{vectorCache.query.entries}</span>
                            <span>Hits / Misses</span><span class="text-right font-mono text-textcolor">{vectorCache.query.hits} / {vectorCache.query.misses}</span>
                            <span>Coalesced</span><span class="text-right font-mono text-textcolor">{vectorCache.query.coalesced}</span>
                        </div>
                    </div>
                </div>

                <div class="flex items-start gap-2.5 rounded-xl border border-darkborderc bg-bgcolor/40 p-3.5 text-xs text-textcolor2">
                    <InfoIcon class="h-4 w-4 shrink-0 mt-0.5" />
                    <span class="leading-relaxed">캐시를 비워도 채팅이나 Hypa 메모리 데이터는 삭제되지 않습니다. 다음 검색에서 필요한 임베딩만 자동으로 다시 생성됩니다.</span>
                </div>
            {:else if vectorCacheLoading}
                <div class="flex min-h-36 items-center justify-center gap-2 text-sm text-textcolor2">
                    <RefreshCwIcon class="h-4 w-4 animate-spin" />
                    캐시 상태를 불러오는 중...
                </div>
            {/if}
        </div>
    {/if}

    <!-- ══════════════════════════════════════════════════════════════ -->
    <!-- SECTION 3: BACKUP DATABASE                                   -->
    <!-- ══════════════════════════════════════════════════════════════ -->
    {#if activeSection === 'backup'}
        <!-- Backup Vendor Selector Cards (Full Width) -->
        <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2.5">
                    <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-darkbutton text-textcolor border border-darkborderc">
                        <ShieldCheckIcon class="h-5 w-5" />
                    </div>
                    <div class="flex items-center gap-2">
                        <h3 class="text-sm sm:text-base font-bold text-textcolor">{language.sqlBackupTitle}</h3>
                        <button
                            type="button"
                            class="text-textcolor2 hover:text-textcolor transition-colors cursor-pointer p-0.5"
                            title={language.sqlBackupDescription}
                            onclick={() => alertNormal(language.sqlBackupDescription)}
                            aria-label="도움말"
                        >
                            <CircleQuestionMarkIcon size={14} />
                        </button>
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    {#if localBackup}
                        <span class="rounded-full px-2.5 py-0.5 text-xs font-medium {localBackup.enabled ? 'bg-darkbutton border border-darkborderc text-textcolor flex items-center gap-1' : 'bg-darkbutton text-textcolor2'}">
                            {#if localBackup.enabled}
                                <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                            {/if}
                            {localBackup.enabled ? language.sqlBackupStatusEnabled : language.sqlBackupStatusDisabled}
                        </span>
                    {/if}
                    <button
                        type="button"
                        class="p-1.5 text-textcolor2 hover:text-textcolor hover:bg-darkbutton rounded-lg transition-colors cursor-pointer"
                        onclick={refreshBackupStatus}
                        title="Refresh Backup Status"
                    >
                        <RefreshCwIcon class="h-4 w-4" />
                    </button>
                </div>
            </div>

            {#if backupLoadError}
                <div class="rounded-xl border border-draculared/50 bg-draculared/10 p-3 text-xs text-draculared">
                    {backupLoadError}
                </div>
            {/if}

            <!-- Vendor Selector Cards -->
            <div class="space-y-2 pt-1">
                <span class="text-xs font-semibold uppercase tracking-wider text-textcolor2">{language.sqlBackupChooseVendor}</span>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <button
                        type="button"
                        class="rounded-xl border p-4 text-left transition-all cursor-pointer {backupVendor === 'postgres' ? 'border-darkborderc bg-selected text-textcolor ring-1 ring-darkborderc shadow-xs font-medium' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg text-textcolor2'}"
                        onclick={() => backupVendor = 'postgres'}
                        title={language.sqlVendorPostgresDesc}
                    >
                        <div class="text-xs sm:text-sm font-bold text-textcolor">{language.sqlVendorPostgres}</div>
                        <div class="mt-1 text-[11px] text-textcolor2 truncate">{language.sqlVendorPostgresDesc}</div>
                    </button>

                    <button
                        type="button"
                        class="rounded-xl border p-4 text-left transition-all cursor-pointer {backupVendor === 'oracle' ? 'border-darkborderc bg-selected text-textcolor ring-1 ring-darkborderc shadow-xs font-medium' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg text-textcolor2'}"
                        onclick={() => backupVendor = 'oracle'}
                        title={language.sqlVendorOracleDesc}
                    >
                        <div class="text-xs sm:text-sm font-bold text-textcolor">{language.sqlVendorOracle}</div>
                        <div class="mt-1 text-[11px] text-textcolor2 truncate">{language.sqlVendorOracleDesc}</div>
                    </button>

                    <button
                        type="button"
                        class="rounded-xl border p-4 text-left transition-all cursor-pointer {backupVendor === 'azure' ? 'border-darkborderc bg-selected text-textcolor ring-1 ring-darkborderc shadow-xs font-medium' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg text-textcolor2'}"
                        onclick={() => backupVendor = 'azure'}
                        title={language.sqlVendorAzureDesc}
                    >
                        <div class="text-xs sm:text-sm font-bold text-textcolor">{language.sqlVendorAzure}</div>
                        <div class="mt-1 text-[11px] text-textcolor2 truncate">{language.sqlVendorAzureDesc}</div>
                    </button>
                </div>
            </div>
        </div>

        <!-- 2-Column Responsive Dashboard for Backup (Desktop lg:grid-cols-12) -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
            <!-- Left Main Column: Form & Options (7 cols) -->
            <div class="lg:col-span-7 xl:col-span-7 space-y-5">
                <!-- Connection Form Card -->
                <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs space-y-4">
                    <h4 class="text-sm font-bold text-textcolor flex items-center gap-2 border-b border-darkborderc/60 pb-3">
                        <DatabaseIcon class="h-4 w-4 text-textcolor" />
                        <span>백업 데이터베이스 연결 정보</span>
                    </h4>

                    {#if backupVendor === 'postgres'}
                        <div class="space-y-4">
                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="backup-pg-connection-string">
                                    {language.postgresConnectionString}
                                </label>
                                <TextInput
                                    id="backup-pg-connection-string"
                                    bind:value={backupPgConnectionString}
                                    fullwidth={true}
                                    placeholder="postgresql://user:password@host:5432/backup_database"
                                    className="mt-1 text-xs"
                                />
                            </div>

                            <div class="w-full sm:w-48">
                                <label class="block text-xs font-medium text-textcolor2" for="backup-pool-size">{language.postgresPoolSize}</label>
                                <NumberInput id="backup-pool-size" bind:value={backupPoolMax} min={1} max={100} fullwidth={true} className="mt-1 text-xs" />
                            </div>
                        </div>
                    {:else if backupVendor === 'oracle'}
                        <div class="space-y-4">
                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-user">{language.oracleUser}</label>
                                    <TextInput id="backup-oracle-user" bind:value={backupOracleUser} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-password">{language.oraclePassword}</label>
                                    <TextInput id="backup-oracle-password" bind:value={backupOraclePassword} hideText={true} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-tns">{language.oracleTnsAlias}</label>
                                    <TextInput id="backup-oracle-tns" bind:value={backupOracleTnsAlias} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-pool">{language.postgresPoolSize}</label>
                                    <NumberInput id="backup-oracle-pool" bind:value={backupPoolMax} min={1} max={100} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-wallet">{language.oracleWalletPath}</label>
                                    <TextInput id="backup-oracle-wallet" bind:value={backupOracleWalletPath} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-wallet-password">{language.oracleWalletPassword}</label>
                                    <TextInput id="backup-oracle-wallet-password" bind:value={backupOracleWalletPassword} hideText={true} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                            </div>
                        </div>
                    {:else if backupVendor === 'azure'}
                        <div class="space-y-4">
                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <div class="sm:col-span-2">
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-azure-host">{language.azureHost}</label>
                                    <TextInput id="backup-azure-host" bind:value={backupAzureHost} fullwidth={true} placeholder="server.database.windows.net" className="mt-1 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-azure-port">{language.azurePort}</label>
                                    <NumberInput id="backup-azure-port" bind:value={backupAzurePort} min={1} max={65535} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                            </div>

                            <div>
                                <label class="block text-xs font-medium text-textcolor2" for="backup-azure-database">{language.azureDatabase}</label>
                                <TextInput id="backup-azure-database" bind:value={backupAzureDatabase} fullwidth={true} className="mt-1 text-xs" />
                            </div>

                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-azure-username">{language.azureUsername}</label>
                                    <TextInput id="backup-azure-username" bind:value={backupAzureUsername} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-azure-password">{language.azurePassword}</label>
                                    <TextInput id="backup-azure-password" bind:value={backupAzurePassword} hideText={true} fullwidth={true} className="mt-1 text-xs" />
                                </div>
                            </div>

                            <div class="w-full sm:w-48">
                                <label class="block text-xs font-medium text-textcolor2" for="backup-azure-pool">{language.postgresPoolSize}</label>
                                <NumberInput id="backup-azure-pool" bind:value={backupPoolMax} min={1} max={100} fullwidth={true} className="mt-1 text-xs" />
                            </div>
                        </div>
                    {/if}
                </div>

                <!-- Backup Options: Mirroring & Snapshot -->
                <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
                    <h4 class="text-sm font-bold text-textcolor flex items-center gap-2 border-b border-darkborderc/60 pb-3">
                        <ClockIcon class="h-4 w-4 text-textcolor" />
                        <span>복제 및 스냅샷 옵션</span>
                    </h4>

                    <div class="rounded-xl border border-darkborderc/80 bg-bgcolor/40 p-3.5 space-y-3">
                        <div class="flex items-center gap-2">
                            <CheckInput bind:check={backupMirroring} name={language.sqlBackupMirroring} />
                            <button
                                type="button"
                                class="text-textcolor2/70 hover:text-textcolor p-0.5 transition-colors cursor-pointer"
                                title={language.sqlBackupMirroringDescription}
                                onclick={() => alertNormal(language.sqlBackupMirroringDescription)}
                                aria-label="도움말"
                            >
                                <CircleQuestionMarkIcon size={14} />
                            </button>
                        </div>

                        <div class="space-y-2 pt-2 border-t border-darkborderc/40">
                            <div class="flex items-center gap-2">
                                <CheckInput bind:check={backupSnapshotEnabled} name={language.sqlBackupSnapshot} />
                                <button
                                    type="button"
                                    class="text-textcolor2/70 hover:text-textcolor p-0.5 transition-colors cursor-pointer"
                                    title={language.sqlBackupSnapshotDescription}
                                    onclick={() => alertNormal(language.sqlBackupSnapshotDescription)}
                                    aria-label="도움말"
                                >
                                    <CircleQuestionMarkIcon size={14} />
                                </button>
                            </div>

                            {#if backupSnapshotEnabled}
                                <div class="pl-6 pt-1 w-full sm:w-64">
                                    <label class="block text-xs font-medium text-textcolor2" for="backup-snapshot-interval">
                                        {language.sqlBackupSnapshotInterval}
                                    </label>
                                    <NumberInput
                                        id="backup-snapshot-interval"
                                        bind:value={backupSnapshotInterval}
                                        min={5}
                                        max={1440}
                                        fullwidth={true}
                                        className="mt-1 text-xs"
                                    />
                                </div>
                            {/if}
                        </div>
                    </div>

                    <!-- Action Toolbar -->
                    <div class="flex flex-wrap items-center gap-2.5 pt-2">
                        <Button disabled={busy || backupTesting} onclick={testBackupConnection}>
                            {backupTesting ? language.s3Testing : language.s3TestConnection}
                        </Button>

                        <Button className="bg-selected hover:opacity-90 font-medium" disabled={busy || backupApplying} onclick={applyBackupConfiguration}>
                            {backupApplying ? language.s3Applying : language.sqlBackupApply}
                        </Button>
                    </div>
                </div>
            </div>

            <!-- Right Sidebar Column: Live Status & Actions (5 cols) -->
            <div class="lg:col-span-5 xl:col-span-5 space-y-5">
                <!-- Live Status Dashboard -->
                {#if localBackup?.configured}
                    <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs text-xs text-textcolor2 space-y-4">
                        <div class="flex items-center justify-between border-b border-darkborderc/60 pb-3">
                            <span class="font-bold text-textcolor text-sm flex items-center gap-2">
                                <ShieldCheckIcon class="h-4 w-4 text-textcolor" />
                                <span>백업 복제 상태</span>
                            </span>
                            {#if localBackup.inFlight && !backupResyncing && !backupRestoring}
                                <span class="text-xs text-textcolor2 font-mono animate-pulse">{language.sqlBackupInProgress}</span>
                            {/if}
                        </div>

                        <!-- 3 Metric Tiles -->
                        <div class="grid grid-cols-3 gap-2 font-mono">
                            <div class="rounded-xl bg-bgcolor/40 p-2.5 border border-darkborderc/60 text-center">
                                <div class="text-[10px] text-textcolor2 uppercase font-medium">{language.sqlBackupPrimaryRevision}</div>
                                <div class="text-base font-bold text-textcolor mt-0.5">#{localBackup.primaryRevision ?? '—'}</div>
                            </div>

                            <div class="rounded-xl bg-bgcolor/40 p-2.5 border border-darkborderc/60 text-center">
                                <div class="text-[10px] text-textcolor2 uppercase font-medium">{language.sqlBackupBackupRevision}</div>
                                <div class="text-base font-bold text-textcolor mt-0.5">#{localBackup.backupRevision ?? '—'}</div>
                            </div>

                            <div class="rounded-xl bg-bgcolor/40 p-2.5 border border-darkborderc/60 text-center">
                                <div class="text-[10px] text-textcolor2 uppercase font-medium">{language.sqlBackupLag}</div>
                                <div class="text-base font-bold mt-0.5 {(localBackup.lag ?? 0) > 0 ? 'text-amber-400' : 'text-textcolor'}">
                                    {localBackup.lag ?? 0}
                                </div>
                            </div>
                        </div>

                        <div class="space-y-1.5 pt-1 text-[11px] border-t border-darkborderc/40">
                            <p class="flex items-center justify-between py-0.5">
                                <span>{language.sqlBackupLastMirror}:</span>
                                <span class="text-textcolor font-mono">{formatTime(localBackup.lastMirrorAt)}</span>
                            </p>
                            <p class="flex items-center justify-between py-0.5">
                                <span>{language.sqlBackupLastSnapshot}:</span>
                                <span class="text-textcolor font-mono">{formatTime(localBackup.lastSnapshotAt)}</span>
                            </p>
                            <p class="flex items-center justify-between py-0.5">
                                <span>{language.sqlBackupLastFullSync}:</span>
                                <span class="text-textcolor font-mono">{formatTime(localBackup.lastFullSyncAt)}</span>
                            </p>
                        </div>

                        {#if localBackup.lastMirrorError}
                            <p class="text-xs text-draculared bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-xl">{language.sqlBackupLastError}: {localBackup.lastMirrorError}</p>
                        {/if}
                        {#if localBackup.lastSnapshotError}
                            <p class="text-xs text-draculared bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-xl">{language.sqlBackupLastError}: {localBackup.lastSnapshotError}</p>
                        {/if}
                        {#if localBackup.lastFullSyncError}
                            <p class="text-xs text-draculared bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-xl">{language.sqlBackupLastError}: {localBackup.lastFullSyncError}</p>
                        {/if}
                    </div>

                    <!-- Maintenance & Recovery Card -->
                    <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
                        <h4 class="text-sm font-bold text-textcolor flex items-center gap-2 border-b border-darkborderc/60 pb-3">
                            <ZapIcon class="h-4 w-4 text-textcolor" />
                            <span>유지보수 및 복구 도구</span>
                        </h4>

                        <div class="space-y-2.5">
                            <!-- Full Resync Action Item -->
                            <div class="flex items-center justify-between gap-3 rounded-xl border border-darkborderc/80 bg-bgcolor/40 p-3">
                                <div class="flex items-center gap-3 min-w-0">
                                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-textcolor border border-darkborderc">
                                        <RefreshCwIcon class="h-4 w-4 {backupResyncing ? 'animate-spin' : ''}" />
                                    </div>
                                    <div class="min-w-0">
                                        <div class="text-xs font-bold text-textcolor">
                                            {language.sqlBackupResync}
                                        </div>
                                        <div class="text-[11px] text-textcolor2 truncate">메인 데이터베이스 전체 백업</div>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    disabled={busy || backupResyncing}
                                    onclick={resyncBackupNow}
                                    className="shrink-0 inline-flex items-center gap-1.5 font-medium"
                                >
                                    {#if backupResyncing}
                                        <RefreshCwIcon class="h-3.5 w-3.5 animate-spin" />
                                        <span>{language.sqlBackupResyncBusy}</span>
                                    {:else}
                                        <span>백업 실행</span>
                                    {/if}
                                </Button>
                            </div>

                            <!-- Restore to Main Action Item -->
                            <div class="flex items-center justify-between gap-3 rounded-xl border border-darkborderc/80 bg-bgcolor/40 p-3">
                                <div class="flex items-center gap-3 min-w-0">
                                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-textcolor border border-darkborderc">
                                        <ZapIcon class="h-4 w-4" />
                                    </div>
                                    <div class="min-w-0">
                                        <div class="text-xs font-bold text-textcolor">
                                            {language.sqlBackupRestoreToMain}
                                        </div>
                                        <div class="text-[11px] text-textcolor2 truncate">백업 DB의 데이터를 메인 DB로 복원</div>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    className="shrink-0 inline-flex items-center gap-1.5 font-medium"
                                    disabled={busy || backupRestoring}
                                    onclick={restoreFromBackupNow}
                                >
                                    {#if backupRestoring}
                                        <RefreshCwIcon class="h-3.5 w-3.5 animate-spin" />
                                        <span>{language.sqlBackupRestoringBusy}</span>
                                    {:else}
                                        <span>복구 실행</span>
                                    {/if}
                                </Button>
                            </div>

                            <!-- Remove Backup Action Item -->
                            <div class="flex items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
                                <div class="flex items-center gap-3 min-w-0">
                                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/40">
                                        <Trash2Icon class="h-4 w-4" />
                                    </div>
                                    <div class="min-w-0">
                                        <div class="text-xs font-bold text-rose-200">
                                            {language.sqlBackupRemove}
                                        </div>
                                        <div class="text-[11px] text-rose-300/80 truncate">백업 데이터베이스 연결 해제</div>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    className="shrink-0 inline-flex items-center gap-1.5 bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 border-rose-500/40 font-medium"
                                    disabled={busy || backupRemoving}
                                    onclick={removeBackupConfiguration}
                                >
                                    <Trash2Icon class="h-3.5 w-3.5" />
                                    <span>해제</span>
                                </Button>
                            </div>
                        </div>
                    </div>
                {:else}
                    <!-- Information Card when not configured -->
                    <div class="rounded-2xl border border-darkborderc/70 bg-darkbg/60 p-4 sm:p-5 shadow-xs space-y-3 text-xs text-textcolor2">
                        <div class="flex items-center gap-2 font-semibold text-textcolor text-sm">
                            <ShieldIcon class="h-4.5 w-4.5 text-textcolor" />
                            <span>백업 데이터베이스 소개</span>
                        </div>
                        <p class="leading-relaxed">
                            메인 데이터베이스와 독립된 별도의 2차 SQL 데이터베이스를 구성하여 실시간 미러링 및 주기적 스냅샷 백업을 수행합니다.
                        </p>
                        <ul class="space-y-1.5 text-[11px] leading-relaxed list-disc list-inside pt-1">
                            <li><strong class="text-textcolor">실시간 미러링</strong>: 메인 DB 변경 즉시 동기화</li>
                            <li><strong class="text-textcolor">정기 스냅샷</strong>: 지정된 주기마다 전체 일관성 백업</li>
                            <li><strong class="text-textcolor">원클릭 복구</strong>: 장애 발생 시 백업에서 메인 DB로 즉시 복구</li>
                        </ul>
                    </div>
                {/if}

                <!-- Real-time Progress HUD for Sync/Restore -->
                {#if (backupResyncing || backupRestoring) && backupProgressData}
                    <div class="rounded-2xl border border-darkborderc bg-selected p-4 text-textcolor shadow-md animate-in fade-in duration-200">
                        <div class="flex items-center justify-between text-xs font-semibold">
                            <span>{backupProgressData.message || (backupRestoring ? language.sqlBackupProgressRestoring : language.sqlBackupResyncBusy)}</span>
                            <span class="font-mono text-textcolor">{backupProgressData.percentage}%</span>
                        </div>
                        <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-darkbg">
                            <div class="h-full bg-textcolor2 transition-all duration-300" style="width: {backupProgressData.percentage}%"></div>
                        </div>
                    </div>
                {/if}
            </div>
        </div>
    {/if}
</div>
