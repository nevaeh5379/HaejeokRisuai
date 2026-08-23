<script lang="ts">
    import { onMount } from 'svelte'
    import {
        ArrowRightLeftIcon,
        CheckCircle2Icon,
        ClockIcon,
        DatabaseIcon,
        DownloadIcon,
        FolderArchiveIcon,
        HardDriveIcon,
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
    import { getNodeStorage } from '../utils'
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

    let activeSection = $state<'assets' | 'backup'>('assets')

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

    onMount(() => {
        refreshBackupStatus()
    })
</script>

<div class="max-w-4xl space-y-5 select-none">
    <!-- Sub-navigation Header: Asset Storage vs Backup Database -->
    <div class="flex items-center justify-between border-b border-darkborderc pb-3">
        <div class="flex items-center gap-1.5 rounded-xl border border-darkborderc bg-darkbg p-1 text-xs">
            <button
                type="button"
                class="flex items-center gap-2 rounded-lg px-3.5 py-1.5 transition-all cursor-pointer {activeSection === 'assets' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => activeSection = 'assets'}
            >
                <HardDriveIcon class="h-4 w-4 shrink-0" />
                <span>{language.storageTabBackend}</span>
                {#if config}
                    <span class="rounded-full px-1.5 py-0.2 text-[10px] font-mono {config.enabled ? 'bg-blue-500/20 text-blue-300' : 'bg-darkbutton text-textcolor2'}">
                        {config.storageType.toUpperCase()}
                    </span>
                {/if}
            </button>

            <button
                type="button"
                class="flex items-center gap-2 rounded-lg px-3.5 py-1.5 transition-all cursor-pointer {activeSection === 'backup' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => activeSection = 'backup'}
            >
                <ShieldCheckIcon class="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{language.sqlBackupTitle}</span>
                {#if localBackup?.configured}
                    <span class="rounded-full px-1.5 py-0.2 text-[10px] font-mono {localBackup.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-darkbutton text-textcolor2'}">
                        {localBackup.enabled ? language.storageActive : language.storageInactive}
                    </span>
                {/if}
            </button>
        </div>
    </div>

    <!-- ══════════════════════════════════════════════════════════════ -->
    <!-- SECTION 1: ASSET STORAGE BACKEND                              -->
    <!-- ══════════════════════════════════════════════════════════════ -->
    {#if activeSection === 'assets'}
        <!-- Backend Selector: Segment Cards -->
        <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
            <div class="flex items-center justify-between gap-2">
                <div>
                    <h3 class="text-sm sm:text-base font-bold text-textcolor">{language.storageBackendSelect}</h3>
                    <p class="mt-0.5 text-xs text-textcolor2">{language.storageBackendSelectDescription}</p>
                </div>
                {#if config}
                    <span class="rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0 {config.enabled ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-darkbutton text-textcolor2'}">
                        {config.storageType === 'azuresql' ? language.storageBackendAzureSql : (config.storageType === 's3' ? language.storageBackendS3 : language.storageBackendLocalFs)}
                    </span>
                {/if}
            </div>

            {#if config?.managedByEnvironment}
                <div class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                    {language.s3EnvironmentManaged}
                </div>
            {/if}

            <!-- Segment Cards -->
            <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-3">
                <!-- Local FS Card -->
                <button
                    type="button"
                    class="flex flex-col items-start rounded-xl border p-3.5 sm:p-4 text-left transition-all cursor-pointer {storageType === 'fs' ? 'border-indigo-500 bg-indigo-500/10 ring-1 ring-indigo-500/40 shadow-xs' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config?.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => onSelectBackend('fs')}
                    disabled={config?.managedByEnvironment}
                >
                    <div class="flex items-center gap-2">
                        <FolderArchiveIcon class="h-4.5 w-4.5 text-indigo-400 shrink-0" />
                        <span class="text-xs sm:text-sm font-bold text-textcolor">{language.storageBackendLocalFs}</span>
                    </div>
                    <p class="mt-1.5 text-[11px] text-textcolor2 leading-relaxed">{language.storageBackendFsDesc}</p>
                </button>

                <!-- S3 Card -->
                <button
                    type="button"
                    class="flex flex-col items-start rounded-xl border p-3.5 sm:p-4 text-left transition-all cursor-pointer {storageType === 's3' ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40 shadow-xs' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config?.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => onSelectBackend('s3')}
                    disabled={config?.managedByEnvironment}
                >
                    <div class="flex items-center gap-2">
                        <ServerIcon class="h-4.5 w-4.5 text-blue-400 shrink-0" />
                        <span class="text-xs sm:text-sm font-bold text-textcolor">{language.storageBackendS3}</span>
                    </div>
                    <p class="mt-1.5 text-[11px] text-textcolor2 leading-relaxed">{language.storageBackendS3Desc}</p>
                </button>

                <!-- Azure SQL Card -->
                <button
                    type="button"
                    class="flex flex-col items-start rounded-xl border p-3.5 sm:p-4 text-left transition-all cursor-pointer {storageType === 'azuresql' ? 'border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/40 shadow-xs' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config?.azureManagedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => onSelectBackend('azuresql')}
                    disabled={config?.azureManagedByEnvironment}
                >
                    <div class="flex items-center gap-2">
                        <DatabaseIcon class="h-4.5 w-4.5 text-sky-400 shrink-0" />
                        <span class="text-xs sm:text-sm font-bold text-textcolor">{language.storageBackendAzureSql}</span>
                    </div>
                    <p class="mt-1.5 text-[11px] text-textcolor2 leading-relaxed">{language.storageBackendAzureSqlDesc}</p>
                </button>
            </div>
        </div>

        <!-- S3 Config Form -->
        {#if storageType === 's3'}
            <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
                <div class="flex items-center justify-between">
                    <h4 class="text-sm font-bold text-textcolor flex items-center gap-2">
                        <ServerIcon class="h-4 w-4 text-blue-400" />
                        <span>{language.storageConnectionSettings} (S3 / RustFS)</span>
                    </h4>
                </div>

                <div class="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="s3-endpoint">{language.s3Endpoint}</label>
                        <TextInput id="s3-endpoint" bind:value={endpoint} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="http://127.0.0.1:9000" className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="s3-bucket">{language.s3Bucket}</label>
                        <TextInput id="s3-bucket" bind:value={bucket} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="risuai-assets" className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="s3-access-key">{language.s3AccessKeyId}</label>
                        <TextInput id="s3-access-key" bind:value={accessKeyId} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="rustfsadmin" className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="s3-secret-key">{language.s3SecretAccessKey}</label>
                        <TextInput id="s3-secret-key" bind:value={secretAccessKey} hideText={true} fullwidth={true} disabled={config?.managedByEnvironment} placeholder={config?.hasSecretAccessKey ? '•••••••••••• (저장됨 / 변경 시 입력)' : 'rustfsadmin'} className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="s3-region">{language.s3Region}</label>
                        <TextInput id="s3-region" bind:value={region} fullwidth={true} disabled={config?.managedByEnvironment} placeholder="us-east-1" className="mt-1 text-xs" />
                    </div>
                </div>

                <div class="flex flex-col gap-2 pt-2">
                    <CheckInput bind:check={forcePathStyle} name={language.s3ForcePathStyle} />
                    <CheckInput bind:check={autoCreateBucket} name={language.s3AutoCreateBucket} />
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
            <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-4">
                <h4 class="text-sm font-bold text-textcolor flex items-center gap-2">
                    <DatabaseIcon class="h-4 w-4 text-sky-400" />
                    <span>{language.storageAzureSqlConnectionSettings}</span>
                </h4>

                {#if config?.azureManagedByEnvironment}
                    <p class="rounded-md border border-borderc bg-bgcolor/40 p-2 text-xs text-textcolor2">
                        {language.azureSqlManagedByEnv}
                    </p>
                {/if}

                <div class="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-server">{language.azureSqlHost}</label>
                        <TextInput id="azure-server" bind:value={azureServer} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="your-server.database.windows.net" className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-database">{language.azureSqlDatabase}</label>
                        <TextInput id="azure-database" bind:value={azureDatabase} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="risuai_assets" className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-user">{language.azureSqlUser}</label>
                        <TextInput id="azure-user" bind:value={azureUser} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="admin" className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-password">{language.azureSqlPassword}</label>
                        <TextInput id="azure-password" bind:value={azurePassword} hideText={true} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder={config?.hasAzurePassword ? '•••••••••••• (저장됨 / 변경 시 입력)' : ''} className="mt-1 text-xs" />
                    </div>

                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-port">{language.azureSqlPort}</label>
                        <TextInput id="azure-port" bind:value={azurePort} fullwidth={true} disabled={config?.azureManagedByEnvironment} placeholder="1433" className="mt-1 text-xs" />
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
            <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-3">
                <h4 class="text-sm font-bold text-textcolor flex items-center gap-2">
                    <FolderArchiveIcon class="h-4 w-4 text-indigo-400" />
                    <span>{language.storageBackendLocalFs}</span>
                </h4>
                <p class="text-xs text-textcolor2 leading-relaxed">{language.storageBackendFsDesc}</p>

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

        <!-- Migration & Rollback Tools -->
        <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs space-y-3">
            <h4 class="text-sm font-bold text-textcolor flex items-center gap-2">
                <ArrowRightLeftIcon class="h-4 w-4 text-textcolor2" />
                <span>{language.s3StatsAndTools}</span>
            </h4>
            <p class="text-xs text-textcolor2">{language.s3StatsAndToolsDescription}</p>

            <div class="flex flex-wrap items-center gap-2.5 pt-2">
                <Button disabled={migrating || !config?.enabled} onclick={onMigrateToS3}>
                    <UploadIcon class="h-3.5 w-3.5 mr-1" />
                    <span>{migrating ? language.s3Migrating : (config?.storageType === 'azuresql' ? language.azureSqlStorageMigrateFromLocal : language.s3MigrateFromLocal)}</span>
                </Button>

                <Button disabled={rollingBack || !config?.enabled} onclick={onRollbackToLocal}>
                    <DownloadIcon class="h-3.5 w-3.5 mr-1" />
                    <span>{rollingBack ? language.s3RollingBack : (config?.storageType === 'azuresql' ? language.azureSqlStorageRollbackToLocal : language.s3RollbackToLocal)}</span>
                </Button>

                {#if config?.enabled && (storageSummary?.localFs?.totalObjects ?? 0) > 0}
                    <Button
                        className="bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30"
                        disabled={purgingLocal || busy}
                        onclick={onPurgeLocalFs}
                    >
                        <Trash2Icon class="h-3.5 w-3.5 mr-1" />
                        <span>{purgingLocal ? language.storagePurging : language.storagePurgeLocalFs}</span>
                    </Button>
                {/if}
            </div>
        </div>
    {/if}

    <!-- ══════════════════════════════════════════════════════════════ -->
    <!-- SECTION 2: BACKUP DATABASE                                   -->
    <!-- ══════════════════════════════════════════════════════════════ -->
    {#if activeSection === 'backup'}
        <div class="rounded-2xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs space-y-5">
            <!-- Header with Status -->
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-darkborderc/60 pb-3">
                <div class="flex items-center gap-2.5">
                    <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                        <ShieldCheckIcon class="h-5 w-5" />
                    </div>
                    <div>
                        <h3 class="text-sm sm:text-base font-bold text-textcolor">{language.sqlBackupTitle}</h3>
                        <p class="text-xs text-textcolor2">{language.sqlBackupDescription}</p>
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    {#if localBackup}
                        <span class="rounded-full px-2.5 py-0.5 text-xs font-medium {localBackup.enabled ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-darkbutton text-textcolor2'}">
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

            <!-- ── Backup Vendor Selector Cards ── -->
            <div class="space-y-2">
                <span class="text-xs font-semibold uppercase tracking-wider text-textcolor2">{language.sqlBackupChooseVendor}</span>
                <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    <button
                        type="button"
                        class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {backupVendor === 'postgres' ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40 shadow-xs' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                        onclick={() => backupVendor = 'postgres'}
                    >
                        <div class="text-xs sm:text-sm font-bold text-textcolor">{language.sqlVendorPostgres}</div>
                        <div class="mt-1 text-[11px] text-textcolor2">{language.sqlVendorPostgresDesc}</div>
                    </button>

                    <button
                        type="button"
                        class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {backupVendor === 'oracle' ? 'border-red-500 bg-red-500/10 ring-1 ring-red-500/40 shadow-xs' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                        onclick={() => backupVendor = 'oracle'}
                    >
                        <div class="text-xs sm:text-sm font-bold text-textcolor">{language.sqlVendorOracle}</div>
                        <div class="mt-1 text-[11px] text-textcolor2">{language.sqlVendorOracleDesc}</div>
                    </button>

                    <button
                        type="button"
                        class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {backupVendor === 'azure' ? 'border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/40 shadow-xs' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                        onclick={() => backupVendor = 'azure'}
                    >
                        <div class="text-xs sm:text-sm font-bold text-textcolor">{language.sqlVendorAzure}</div>
                        <div class="mt-1 text-[11px] text-textcolor2">{language.sqlVendorAzureDesc}</div>
                    </button>
                </div>
            </div>

            <!-- ── Connection Form ── -->
            <div class="space-y-4 pt-1">
                {#if backupVendor === 'postgres'}
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="backup-pg-connection-string">
                            {language.postgresConnectionString}
                        </label>
                        <TextInput
                            id="backup-pg-connection-string"
                            bind:value={backupPgConnectionString}
                            hideText={true}
                            fullwidth={true}
                            placeholder="postgresql://user:password@host:5432/backup_database"
                            className="mt-1 text-xs"
                        />
                    </div>
                {:else if backupVendor === 'oracle'}
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
                            <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-wallet">{language.oracleWalletPath}</label>
                            <TextInput id="backup-oracle-wallet" bind:value={backupOracleWalletPath} fullwidth={true} className="mt-1 text-xs" />
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-textcolor2" for="backup-oracle-wallet-password">{language.oracleWalletPassword}</label>
                            <TextInput id="backup-oracle-wallet-password" bind:value={backupOracleWalletPassword} hideText={true} fullwidth={true} className="mt-1 text-xs" />
                        </div>
                    </div>
                {:else if backupVendor === 'azure'}
                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                            <label class="block text-xs font-medium text-textcolor2" for="backup-azure-host">{language.azureHost}</label>
                            <TextInput id="backup-azure-host" bind:value={backupAzureHost} fullwidth={true} placeholder="server.database.windows.net" className="mt-1 text-xs" />
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-textcolor2" for="backup-azure-database">{language.azureDatabase}</label>
                            <TextInput id="backup-azure-database" bind:value={backupAzureDatabase} fullwidth={true} className="mt-1 text-xs" />
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-textcolor2" for="backup-azure-username">{language.azureUsername}</label>
                            <TextInput id="backup-azure-username" bind:value={backupAzureUsername} fullwidth={true} className="mt-1 text-xs" />
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-textcolor2" for="backup-azure-password">{language.azurePassword}</label>
                            <TextInput id="backup-azure-password" bind:value={backupAzurePassword} hideText={true} fullwidth={true} className="mt-1 text-xs" />
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-textcolor2" for="backup-azure-port">{language.azurePort}</label>
                            <NumberInput id="backup-azure-port" bind:value={backupAzurePort} min={1} max={65535} fullwidth={true} className="mt-1 text-xs" />
                        </div>
                    </div>
                {/if}

                <div class="w-full sm:w-48">
                    <label class="block text-xs font-medium text-textcolor2" for="backup-pool-size">{language.postgresPoolSize}</label>
                    <NumberInput id="backup-pool-size" bind:value={backupPoolMax} min={1} max={100} fullwidth={true} className="mt-1 text-xs" />
                </div>
            </div>

            <!-- ── Backup Options: Mirroring & Snapshot ── -->
            <div class="rounded-xl border border-darkborderc bg-bgcolor/40 p-4 space-y-3">
                <CheckInput bind:check={backupMirroring} name={language.sqlBackupMirroring} />
                <p class="pl-7 text-xs text-textcolor2">{language.sqlBackupMirroringDescription}</p>

                <div class="pt-2 border-t border-darkborderc/40">
                    <CheckInput bind:check={backupSnapshotEnabled} name={language.sqlBackupSnapshot} />
                    <p class="pl-7 text-xs text-textcolor2">{language.sqlBackupSnapshotDescription}</p>
                </div>

                {#if backupSnapshotEnabled}
                    <div class="pl-7 pt-1 w-full sm:w-64">
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

            <!-- ── Live Status Dashboard (when configured) ── -->
            {#if localBackup?.configured}
                <div class="rounded-xl border border-darkborderc bg-bgcolor/50 p-4 text-xs text-textcolor2 space-y-3">
                    <div class="flex items-center justify-between">
                        <span class="font-bold text-textcolor text-sm flex items-center gap-1.5">
                            <ShieldCheckIcon class="h-4 w-4 text-emerald-400" />
                            <span>백업 복제 상태</span>
                        </span>
                        {#if localBackup.inFlight && !backupResyncing && !backupRestoring}
                            <span class="text-xs text-blue-400 font-mono animate-pulse">{language.sqlBackupInProgress}</span>
                        {/if}
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono">
                        <div class="rounded-lg bg-darkbg p-2.5 border border-darkborderc/50">
                            <div class="text-[10px] text-textcolor2 uppercase">{language.sqlBackupPrimaryRevision}</div>
                            <div class="text-base font-bold text-textcolor">#{localBackup.primaryRevision ?? '—'}</div>
                        </div>

                        <div class="rounded-lg bg-darkbg p-2.5 border border-darkborderc/50">
                            <div class="text-[10px] text-textcolor2 uppercase">{language.sqlBackupBackupRevision}</div>
                            <div class="text-base font-bold text-textcolor">#{localBackup.backupRevision ?? '—'}</div>
                        </div>

                        <div class="rounded-lg bg-darkbg p-2.5 border border-darkborderc/50">
                            <div class="text-[10px] text-textcolor2 uppercase">{language.sqlBackupLag}</div>
                            <div class="text-base font-bold {(localBackup.lag ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}">
                                {localBackup.lag ?? 0}
                            </div>
                        </div>
                    </div>

                    <div class="space-y-1 pt-1 text-[11px]">
                        <p>{language.sqlBackupLastMirror}: <span class="text-textcolor font-mono">{formatTime(localBackup.lastMirrorAt)}</span></p>
                        <p>{language.sqlBackupLastSnapshot}: <span class="text-textcolor font-mono">{formatTime(localBackup.lastSnapshotAt)}</span></p>
                        <p>{language.sqlBackupLastFullSync}: <span class="text-textcolor font-mono">{formatTime(localBackup.lastFullSyncAt)}</span></p>
                    </div>

                    {#if localBackup.lastMirrorError}
                        <p class="text-xs text-draculared bg-rose-500/10 border border-rose-500/20 p-2 rounded-lg">{language.sqlBackupLastError}: {localBackup.lastMirrorError}</p>
                    {/if}
                    {#if localBackup.lastSnapshotError}
                        <p class="text-xs text-draculared bg-rose-500/10 border border-rose-500/20 p-2 rounded-lg">{language.sqlBackupLastError}: {localBackup.lastSnapshotError}</p>
                    {/if}
                    {#if localBackup.lastFullSyncError}
                        <p class="text-xs text-draculared bg-rose-500/10 border border-rose-500/20 p-2 rounded-lg">{language.sqlBackupLastError}: {localBackup.lastFullSyncError}</p>
                    {/if}
                </div>
            {/if}

            <!-- ── Real-time Progress HUD for Sync/Restore ── -->
            {#if (backupResyncing || backupRestoring) && backupProgressData}
                <div class="rounded-xl border border-blue-500/40 bg-blue-500/10 p-4 text-textcolor shadow-md animate-in fade-in duration-200">
                    <div class="flex items-center justify-between text-xs font-semibold">
                        <span>{backupProgressData.message || (backupRestoring ? language.sqlBackupProgressRestoring : language.sqlBackupResyncBusy)}</span>
                        <span class="font-mono text-blue-300">{backupProgressData.percentage}%</span>
                    </div>
                    <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-darkbg">
                        <div class="h-full bg-blue-500 transition-all duration-300" style="width: {backupProgressData.percentage}%"></div>
                    </div>
                </div>
            {/if}

            <!-- ── Action Toolbar ── -->
            <div class="flex flex-wrap items-center gap-2.5 pt-3 border-t border-darkborderc/60">
                <Button disabled={busy || backupTesting} onclick={testBackupConnection}>
                    {backupTesting ? language.s3Testing : language.s3TestConnection}
                </Button>

                <Button className="bg-selected hover:opacity-90 font-medium" disabled={busy || backupApplying} onclick={applyBackupConfiguration}>
                    {backupApplying ? language.s3Applying : language.sqlBackupApply}
                </Button>

                {#if localBackup?.configured}
                    <Button disabled={busy || backupResyncing} onclick={resyncBackupNow}>
                        <RefreshCwIcon class="h-3.5 w-3.5 mr-1 {backupResyncing ? 'animate-spin' : ''}" />
                        <span>{backupResyncing ? language.sqlBackupResyncBusy : language.sqlBackupResync}</span>
                    </Button>

                    <Button
                        className="bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 border border-amber-500/30"
                        disabled={busy || backupRestoring}
                        onclick={restoreFromBackupNow}
                    >
                        <ZapIcon class="h-3.5 w-3.5 mr-1" />
                        <span>{backupRestoring ? language.sqlBackupRestoringBusy : language.sqlBackupRestoreToMain}</span>
                    </Button>

                    <Button
                        className="bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/30"
                        disabled={busy || backupRemoving}
                        onclick={removeBackupConfiguration}
                    >
                        <Trash2Icon class="h-3.5 w-3.5 mr-1" />
                        <span>{language.sqlBackupRemove}</span>
                    </Button>
                {/if}
            </div>
        </div>
    {/if}
</div>
