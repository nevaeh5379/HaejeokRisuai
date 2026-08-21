<script lang="ts">
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { getDatabase } from 'src/ts/storage/database.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import {
        buildSqlVendorParams,
        isSqlVendorParamsComplete,
        type DbVendor,
        type NodeBackupConfig,
        type NodeBackupProgressEvent,
        type NodePostgresServerConfig,
        type SqlVendorFormValues,
    } from 'src/ts/storage/nodePostgresStorage'
    import { encodeRisuSaveLegacy } from 'src/ts/storage/risuSave'
    import { ensureDatabaseFullyLoaded } from 'src/ts/drive/backuplocal'

    interface Props {
        onConfigChanged?: () => void
    }

    const { onConfigChanged }: Props = $props()

    let config = $state<NodePostgresServerConfig | null>(null)
    let dbConfig = $state<{
        vendor: DbVendor
        enabled: boolean
        configured: boolean
        managedByEnvironment: boolean
        params: Record<string, any>
        storedVendor: DbVendor | null
        revision: number | null
        initialized: boolean
    } | null>(null)

    // 폼에서 선택 중인 vendor
    let selectedVendor = $state<DbVendor>('postgres')
    let migrate = $state(false)

    // PostgreSQL 폼 상태
    let connectionString = $state('')
    let poolMax = $state(10)

    // Oracle 폼 상태
    let oracleUser = $state('')
    let oraclePassword = $state('')
    let oracleTnsAlias = $state('')
    let oracleWalletPath = $state('')
    let oracleWalletPassword = $state('')

    // Azure 폼 상태
    let azureHost = $state('')
    let azureDatabase = $state('')
    let azureUsername = $state('')
    let azurePassword = $state('')
    let azurePort = $state(1433)

    // 범용 폼 poolMax
    let vendorPoolMax = $state(10)

    let busy = $state(false)
    let loadError = $state('')

    // ── 백업 데이터베이스 상태 ──
    let backup = $state<NodeBackupConfig | null>(null)
    let backupLoadError = $state('')
    let backupTesting = $state(false)
    let backupResyncing = $state(false)
    let backupRestoring = $state(false)
    let backupProgressData = $state<NodeBackupProgressEvent | null>(null)
    let backupRemoving = $state(false)
    let backupApplying = $state(false)

    let backupVendor = $state<DbVendor | null>(null)
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

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function refresh() {
        busy = true
        loadError = ''
        try {
            const storage = getNodeStorage()
            config = await storage.postgres.getServerConfig()
            poolMax = config.poolMax
            try {
                dbConfig = await storage.postgres.getDatabaseConfig()
                vendorPoolMax = dbConfig.params?.poolMax || 10
                selectedVendor = dbConfig.vendor || dbConfig.storedVendor || 'postgres'
                if (dbConfig.params) {
                    if (dbConfig.vendor === 'oracle' || dbConfig.storedVendor === 'oracle') {
                        oracleUser = dbConfig.params.user || ''
                        oracleTnsAlias = dbConfig.params.tnsAlias || ''
                        oracleWalletPath = dbConfig.params.walletPath || ''
                    } else if (dbConfig.vendor === 'azure' || dbConfig.storedVendor === 'azure') {
                        azureHost = dbConfig.params.server || ''
                        azureDatabase = dbConfig.params.database || ''
                        azureUsername = dbConfig.params.user || ''
                        azurePort = dbConfig.params.port || 1433
                    } else if (dbConfig.vendor === 'postgres' || !dbConfig.vendor) {
                        connectionString = dbConfig.params.connectionString || ''
                    }
                }
            } catch {
                // /api/db-config 미지원 서버 폴백
            }
        } catch (error) {
            loadError = `${error}`
        } finally {
            busy = false
        }
    }

    function buildParams(vendor: DbVendor): Record<string, unknown> {
        const values: SqlVendorFormValues = {
            connectionString,
            server: azureHost,
            database: azureDatabase,
            user: vendor === 'oracle' ? oracleUser : azureUsername,
            password: vendor === 'oracle' ? oraclePassword : azurePassword,
            tnsAlias: oracleTnsAlias,
            walletPath: oracleWalletPath,
            walletPassword: oracleWalletPassword,
            port: azurePort,
            poolMax: vendor === 'postgres' ? poolMax : vendorPoolMax,
        }
        return buildSqlVendorParams(vendor, values)
    }

    async function applyConfiguration() {
        if (!config || config.managedByEnvironment || busy) {
            return
        }
        const vendor: DbVendor = selectedVendor
        const params = buildParams(vendor)

        if (!isSqlVendorParamsComplete(vendor, {
            connectionString,
            server: azureHost,
            database: azureDatabase,
            user: vendor === 'oracle' ? oracleUser : azureUsername,
            password: vendor === 'oracle' ? oraclePassword : azurePassword,
            tnsAlias: oracleTnsAlias,
            walletPath: oracleWalletPath,
            walletPassword: oracleWalletPassword,
            port: azurePort,
            poolMax: vendor === 'postgres' ? poolMax : vendorPoolMax,
        })) {
            alertError(language.sqlConfigIncomplete)
            return
        }

        if (!await alertConfirm(language.postgresApplyConfirm)) {
            return
        }

        busy = true
        try {
            const storage = getNodeStorage()

            try {
                await storage.postgres.applyDatabaseConfig(vendor, params, migrate)
            } catch (e) {
                if (vendor === 'postgres') {
                    await storage.postgres.configureServer({
                        enabled: true,
                        connectionString: connectionString.trim() || undefined,
                        poolMax,
                    })
                } else {
                    throw e
                }
            }
            alertNormal(language.postgresApplySuccess)
            onConfigChanged?.()
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    async function testConnection() {
        if (busy || !config) {
            return
        }
        const vendor: DbVendor = selectedVendor
        const params = buildParams(vendor)
        if (!isSqlVendorParamsComplete(vendor, {
            connectionString,
            server: azureHost,
            database: azureDatabase,
            user: vendor === 'oracle' ? oracleUser : azureUsername,
            password: vendor === 'oracle' ? oraclePassword : azurePassword,
            tnsAlias: oracleTnsAlias,
            walletPath: oracleWalletPath,
            walletPassword: oracleWalletPassword,
            port: azurePort,
            poolMax: vendor === 'postgres' ? poolMax : vendorPoolMax,
        })) {
            alertError(language.sqlConfigIncomplete)
            return
        }
        busy = true
        try {
            const result = await getNodeStorage().postgres.testConnection(vendor, params)
            if (result.success) {
                alertNormal(language.sqlConnectionSuccess)
            } else {
                alertError(result.error || language.sqlConnectionFailed)
            }
        } catch (error) {
            alertError(error)
        } finally {
            busy = false
        }
    }

    // ── 백업 데이터베이스 함수 ──

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
            poolMax: backupPoolMax,
        }
    }

    function buildBackupParams(vendor: DbVendor): Record<string, unknown> {
        return buildSqlVendorParams(vendor, getBackupFormValues(vendor))
    }

    function isBackupParamsComplete(vendor: DbVendor): boolean {
        return isSqlVendorParamsComplete(vendor, getBackupFormValues(vendor))
    }

    async function refreshBackup() {
        backupLoadError = ''
        try {
            backup = await getNodeStorage().postgres.getBackupStatus()
            if (backup.configured && backup.vendor) {
                backupVendor = backup.vendor
                const p = backup.params || {}
                backupPgConnectionString = p.connectionString || ''
                backupPoolMax = p.poolMax || 10
                if (backup.vendor === 'oracle') {
                    backupOracleUser = p.user || ''
                    backupOracleTnsAlias = p.tnsAlias || ''
                    backupOracleWalletPath = p.walletPath || ''
                } else if (backup.vendor === 'azure') {
                    backupAzureHost = p.server || ''
                    backupAzureDatabase = p.database || ''
                    backupAzureUsername = p.user || ''
                    backupAzurePort = p.port || 1433
                }
                backupMirroring = Boolean(backup.mirroring?.enabled)
                backupSnapshotEnabled = Boolean(backup.snapshot?.enabled)
                backupSnapshotInterval = backup.snapshot?.intervalMinutes || 60
            }
        } catch (error) {
            backup = null
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
            const result = await getNodeStorage().postgres.testBackupConnection(backupVendor, buildBackupParams(backupVendor))
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
            backup = await getNodeStorage().postgres.configureBackup({
                vendor: backupVendor,
                params: buildBackupParams(backupVendor),
                mirroring: { enabled: backupMirroring },
                snapshot: { enabled: backupSnapshotEnabled, intervalMinutes: backupSnapshotInterval },
            })
            alertNormal(language.sqlBackupApplySuccess)
            await refreshBackup()
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
            message: language.sqlBackupProgressReading,
        }
        try {
            await getNodeStorage().postgres.resyncBackup((event) => {
                backupProgressData = event
            })
            alertNormal(language.sqlBackupResyncSuccess)
            await refreshBackup()
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
            message: language.sqlBackupProgressRestoring,
        }
        try {
            await getNodeStorage().postgres.restoreFromBackup((event) => {
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
            await getNodeStorage().postgres.removeBackup()
            alertNormal(language.sqlBackupRemoveSuccess)
            backup = null
            backupVendor = null
            await refreshBackup()
        } catch (error) {
            alertError(error)
        } finally {
            backupRemoving = false
        }
    }

    function formatBackupTime(value: string | null | undefined) {
        if (!value) return language.sqlBackupNever
        return new Date(value).toLocaleString()
    }

    onMount(() => {
        refresh()
        refreshBackup()
    })
</script>

<div class="max-w-4xl space-y-6">
    <!-- 메인 데이터베이스 설정 카드 -->
    <section class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
                <h3 class="text-base sm:text-lg font-semibold text-textcolor">{language.sqlStorage}</h3>
                <p class="mt-1 text-xs sm:text-sm text-textcolor2">{language.sqlStorageDescription}</p>
            </div>
            <div class="flex items-center gap-2">
                {#if config?.enabled}
                    <span class="rounded-full bg-bgcolor/80 px-2.5 py-1 text-xs font-mono text-textcolor2 border border-darkborderc">
                        {config.vendor === 'oracle' ? language.sqlVendorOracle :
                         config.vendor === 'azure' ? language.sqlVendorAzure :
                         language.sqlVendorPostgres}
                    </span>
                {/if}
                {#if config}
                    <span class="rounded-full px-2.5 py-1 text-xs font-medium {config.enabled ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-darkbutton text-textcolor2'}">
                        {config.enabled ? language.postgresStatusEnabled : language.postgresStatusDisabled}
                    </span>
                {/if}
            </div>
        </div>

        {#if loadError}
            <p class="mt-4 rounded-lg border border-draculared/50 bg-draculared/10 p-3 text-sm text-draculared">{loadError}</p>
        {:else if !config}
            <p class="mt-4 text-sm text-textcolor2">{language.postgresStatusLoading}</p>
        {:else}
            {#if config.managedByEnvironment}
                <div class="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                    {language.postgresEnvironmentManaged}
                </div>
            {/if}

            <!-- ── 데이터베이스 제공자 선택 ── -->
            <p class="mt-5 text-xs font-semibold uppercase tracking-wider text-textcolor2">{language.sqlQuickSetupChooseVendor}</p>
            <div class="mt-2.5 grid gap-2.5 sm:grid-cols-3">
                <button
                    type="button"
                    class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {selectedVendor === 'postgres' ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => selectedVendor = 'postgres'}
                >
                    <div class="text-sm font-semibold text-textcolor">{language.sqlVendorPostgres}</div>
                    <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorPostgresDesc}</div>
                </button>
                <button
                    type="button"
                    class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {selectedVendor === 'oracle' ? 'border-red-500 bg-red-500/10 ring-1 ring-red-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => selectedVendor = 'oracle'}
                >
                    <div class="text-sm font-semibold text-textcolor">{language.sqlVendorOracle}</div>
                    <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorOracleDesc}</div>
                </button>
                <button
                    type="button"
                    class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {selectedVendor === 'azure' ? 'border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                    onclick={() => selectedVendor = 'azure'}
                >
                    <div class="text-sm font-semibold text-textcolor">{language.sqlVendorAzure}</div>
                    <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorAzureDesc}</div>
                </button>
            </div>

            <!-- ── PostgreSQL 폼 ── -->
            {#if selectedVendor === 'postgres'}
                <div class="mt-5 space-y-4">
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="postgres-connection-string">
                            {language.postgresConnectionString}
                        </label>
                        <TextInput
                            id="postgres-connection-string"
                            bind:value={connectionString}
                            hideText={true}
                            fullwidth={true}
                            disabled={config.managedByEnvironment}
                            placeholder={config.connectionDisplay || 'postgresql://user:password@host:5432/database'}
                            className="mt-1 text-xs"
                        />
                        <p class="mt-1 text-[11px] text-textcolor2">{language.postgresConnectionSecurity}</p>
                    </div>

                    <div class="w-full sm:w-48">
                        <label class="block text-xs font-medium text-textcolor2" for="postgres-pool-size">
                            {language.postgresPoolSize}
                        </label>
                        <NumberInput
                            id="postgres-pool-size"
                            bind:value={poolMax}
                            min={1}
                            max={100}
                            fullwidth={true}
                            disabled={config.managedByEnvironment}
                            className="mt-1 text-xs"
                        />
                    </div>
                </div>
            {/if}

            <!-- ── Oracle 폼 ── -->
            {#if selectedVendor === 'oracle'}
                <div class="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="oracle-user">{language.oracleUser}</label>
                        <TextInput id="oracle-user" bind:value={oracleUser} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="oracle-password">{language.oraclePassword}</label>
                        <TextInput id="oracle-password" bind:value={oraclePassword} hideText={true} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="oracle-tns-alias">{language.oracleTnsAlias}</label>
                        <TextInput id="oracle-tns-alias" bind:value={oracleTnsAlias} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="oracle-wallet-path">{language.oracleWalletPath}</label>
                        <TextInput id="oracle-wallet-path" bind:value={oracleWalletPath} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="oracle-wallet-password">{language.oracleWalletPassword}</label>
                        <TextInput id="oracle-wallet-password" bind:value={oracleWalletPassword} hideText={true} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="oracle-pool-size">{language.postgresPoolSize}</label>
                        <NumberInput id="oracle-pool-size" bind:value={vendorPoolMax} min={1} max={100} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                </div>
            {/if}

            <!-- ── Azure 폼 ── -->
            {#if selectedVendor === 'azure'}
                <div class="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-host">{language.azureHost}</label>
                        <TextInput id="azure-host" bind:value={azureHost} fullwidth={true} disabled={config.managedByEnvironment} placeholder="server.database.windows.net" className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-database">{language.azureDatabase}</label>
                        <TextInput id="azure-database" bind:value={azureDatabase} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-username">{language.azureUsername}</label>
                        <TextInput id="azure-username" bind:value={azureUsername} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-password">{language.azurePassword}</label>
                        <TextInput id="azure-password" bind:value={azurePassword} hideText={true} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-port">{language.azurePort}</label>
                        <NumberInput id="azure-port" bind:value={azurePort} min={1} max={65535} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="azure-pool-size">{language.postgresPoolSize}</label>
                        <NumberInput id="azure-pool-size" bind:value={vendorPoolMax} min={1} max={100} fullwidth={true} disabled={config.managedByEnvironment} className="mt-1 text-xs" />
                    </div>
                </div>
            {/if}

            {#if config.enabled}
                <div class="mt-4 flex items-center gap-3 text-xs text-textcolor2 bg-bgcolor/30 p-2.5 rounded-lg border border-darkborderc/50 font-mono">
                    <span>{language.postgresRevision}: <strong class="text-textcolor">#{config.revision ?? 0}</strong></span>
                    <span>·</span>
                    <span class={config.initialized ? 'text-emerald-400' : 'text-amber-400'}>
                        {config.initialized ? language.postgresInitialized : language.postgresWaitingMigration}
                    </span>
                </div>
            {/if}

            {#if !config.managedByEnvironment}
                <div class="mt-4 rounded-xl border border-darkborderc bg-bgcolor/30 p-3.5">
                    <CheckInput bind:check={migrate} name={language.sqlQuickSetupMigration} />
                    <p class="mt-1 pl-7 text-xs text-textcolor2">{language.sqlQuickSetupMigrationDescription}</p>
                </div>

                <div class="mt-5 flex flex-wrap gap-2.5">
                    <Button disabled={busy} onclick={testConnection}>
                        {busy ? language.sqlTesting : language.sqlTestConnection}
                    </Button>
                    <Button className="bg-selected hover:opacity-90 font-medium" disabled={busy} onclick={applyConfiguration}>
                        {busy ? language.postgresApplying : language.sqlApplyAndConnect}
                    </Button>
                </div>
            {/if}
        {/if}
    </section>

    <!-- 백업 데이터베이스 섹션 -->
    <section class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
                <h3 class="text-base sm:text-lg font-semibold text-textcolor">{language.sqlBackupTitle}</h3>
                <p class="mt-1 text-xs sm:text-sm text-textcolor2">{language.sqlBackupDescription}</p>
            </div>
            {#if backup}
                <span class="rounded-full px-2.5 py-1 text-xs font-medium {backup.enabled ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-darkbutton text-textcolor2'}">
                    {backup.enabled ? language.sqlBackupStatusEnabled : language.sqlBackupStatusDisabled}
                </span>
            {/if}
        </div>

        {#if backupLoadError}
            <p class="mt-4 rounded-lg border border-draculared/50 bg-draculared/10 p-3 text-sm text-draculared">{backupLoadError}</p>
        {:else if backup === null}
            <p class="mt-4 text-sm text-textcolor2">{language.sqlBackupNotConfigured}</p>
        {:else}
            <!-- 제공자 선택 -->
            <p class="mt-5 text-xs font-semibold uppercase tracking-wider text-textcolor2">{language.sqlBackupChooseVendor}</p>
            <div class="mt-2.5 grid gap-2.5 sm:grid-cols-3">
                <button
                    type="button"
                    class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {backupVendor === 'postgres' ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                    onclick={() => backupVendor = 'postgres'}
                >
                    <div class="text-sm font-semibold text-textcolor">{language.sqlVendorPostgres}</div>
                    <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorPostgresDesc}</div>
                </button>
                <button
                    type="button"
                    class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {backupVendor === 'oracle' ? 'border-red-500 bg-red-500/10 ring-1 ring-red-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                    onclick={() => backupVendor = 'oracle'}
                >
                    <div class="text-sm font-semibold text-textcolor">{language.sqlVendorOracle}</div>
                    <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorOracleDesc}</div>
                </button>
                <button
                    type="button"
                    class="rounded-xl border p-3.5 text-left transition-all cursor-pointer {backupVendor === 'azure' ? 'border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                    onclick={() => backupVendor = 'azure'}
                >
                    <div class="text-sm font-semibold text-textcolor">{language.sqlVendorAzure}</div>
                    <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorAzureDesc}</div>
                </button>
            </div>

            <!-- 연결 정보 폼 -->
            {#if backupVendor === 'postgres'}
                <div class="mt-5 space-y-4">
                    <div>
                        <label class="block text-xs font-medium text-textcolor2" for="backup-pg-connection-string">
                            {language.postgresConnectionString}
                        </label>
                        <TextInput
                            id="backup-pg-connection-string"
                            bind:value={backupPgConnectionString}
                            hideText={true}
                            fullwidth={true}
                            placeholder="postgresql://user:password@host:5432/database"
                            className="mt-1 text-xs"
                        />
                    </div>
                </div>
            {:else if backupVendor === 'oracle'}
                <div class="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
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
                <div class="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
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

            {#if backupVendor}
                <div class="mt-4 w-full sm:w-48">
                    <label class="block text-xs font-medium text-textcolor2" for="backup-pool-size">{language.postgresPoolSize}</label>
                    <NumberInput id="backup-pool-size" bind:value={backupPoolMax} min={1} max={100} fullwidth={true} className="mt-1 text-xs" />
                </div>
            {/if}

            <!-- 백업 옵션 -->
            <div class="mt-5 rounded-xl border border-darkborderc bg-bgcolor/30 p-4 space-y-3">
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

            <!-- 상태 모니터링 (설정됨) -->
            {#if backup.configured}
                <div class="mt-4 rounded-xl border border-darkborderc bg-bgcolor/40 p-4 text-xs text-textcolor2">
                    <div class="flex flex-wrap gap-x-6 gap-y-1.5 font-mono">
                        <span>{language.sqlBackupPrimaryRevision}: <strong class="text-textcolor">#{backup.primaryRevision ?? '—'}</strong></span>
                        <span>{language.sqlBackupBackupRevision}: <strong class="text-textcolor">#{backup.backupRevision ?? '—'}</strong></span>
                        {#if backup.lag !== null}
                            <span class="flex items-center gap-1">
                                {language.sqlBackupLag}:
                                <span class="font-bold {backup.lag > 0 ? 'text-amber-400' : 'text-emerald-400'}">{backup.lag}</span>
                            </span>
                        {/if}
                    </div>
                    <div class="mt-3 space-y-1 text-xs text-textcolor2">
                        <p>{language.sqlBackupLastMirror}: <span class="text-textcolor font-mono">{formatBackupTime(backup.lastMirrorAt)}</span></p>
                        <p>{language.sqlBackupLastSnapshot}: <span class="text-textcolor font-mono">{formatBackupTime(backup.lastSnapshotAt)}</span></p>
                        <p>{language.sqlBackupLastFullSync}: <span class="text-textcolor font-mono">{formatBackupTime(backup.lastFullSyncAt)}</span></p>
                    </div>
                    {#if backup.inFlight && !backupResyncing && !backupRestoring}
                        <p class="mt-2.5 text-xs text-blue-400 animate-pulse">{language.sqlBackupInProgress}</p>
                    {/if}
                    {#if backup.lastMirrorError}
                        <p class="mt-2 text-xs text-draculared">{language.sqlBackupLastError}: {backup.lastMirrorError}</p>
                    {/if}
                    {#if backup.lastSnapshotError}
                        <p class="mt-2 text-xs text-draculared">{language.sqlBackupLastError}: {backup.lastSnapshotError}</p>
                    {/if}
                    {#if backup.lastFullSyncError}
                        <p class="mt-2 text-xs text-draculared">{language.sqlBackupLastError}: {backup.lastFullSyncError}</p>
                    {/if}
                </div>
            {/if}

            <!-- 실시간 백업/복원 진행 상황 표시 HUD -->
            {#if (backupResyncing || backupRestoring) && backupProgressData}
                <div class="mt-4 rounded-xl border border-blue-500/40 bg-blue-500/10 p-4 text-textcolor shadow-md transition-all duration-300">
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                            <svg class="h-4 w-4 animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                            </svg>
                            <span class="text-sm font-semibold text-textcolor">
                                {backupProgressData.message || (backupRestoring ? language.sqlBackupProgressRestoring : language.sqlBackupInProgress)}
                            </span>
                        </div>
                        <span class="text-sm font-bold text-blue-400 font-mono">
                            {backupProgressData.percentage ?? 0}%
                        </span>
                    </div>

                    <!-- Progress Bar -->
                    <div class="mt-3 h-2.5 w-full overflow-hidden rounded-full border border-darkborderc bg-bgcolor/60">
                        <div
                            class="h-full bg-blue-500 transition-all duration-300"
                            style="width: {backupProgressData.percentage ?? 0}%"
                        ></div>
                    </div>

                    <!-- Stats breakdown -->
                    {#if backupProgressData.settingsCount !== undefined || backupProgressData.charactersCount !== undefined || backupProgressData.chatsCount !== undefined || backupProgressData.messagesCount !== undefined}
                        <div class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-textcolor2">
                            {#if backupProgressData.settingsCount !== undefined}
                                <span>{language.sqlBackupStatsSettings}: <span class="font-medium text-textcolor">{backupProgressData.settingsCount}</span></span>
                            {/if}
                            {#if backupProgressData.charactersCount !== undefined}
                                <span>{language.sqlBackupStatsCharacters}: <span class="font-medium text-textcolor">{backupProgressData.charactersCount}</span></span>
                            {/if}
                            {#if backupProgressData.chatsCount !== undefined}
                                <span>{language.sqlBackupStatsChats}: <span class="font-medium text-textcolor">{backupProgressData.chatsCount}</span></span>
                            {/if}
                            {#if backupProgressData.messagesCount !== undefined}
                                <span>{language.sqlBackupStatsMessages}: <span class="font-medium text-textcolor">{backupProgressData.messagesCount.toLocaleString()}</span></span>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}

            <!-- 백업 조작 버튼 툴바 -->
            <div class="mt-5 flex flex-wrap gap-2.5">
                <Button disabled={backupTesting || backupApplying || !backupVendor} onclick={testBackupConnection}>
                    {backupTesting ? language.sqlTesting : language.sqlTestConnection}
                </Button>
                <Button className="bg-selected hover:opacity-90 font-medium" disabled={backupApplying || backupResyncing || backupRestoring || !backupVendor} onclick={applyBackupConfiguration}>
                    {backupApplying ? language.postgresApplying : language.sqlBackupApply}
                </Button>

                {#if backup.configured}
                    <!-- 메인 -> 백업 수동 동기화 -->
                    <Button disabled={backupResyncing || backupRestoring || backupApplying} onclick={resyncBackupNow}>
                        {backupResyncing ? language.sqlBackupResyncBusy : language.sqlBackupResync}
                    </Button>

                    <!-- 백업 -> 메인 덮어쓰기 복원 (신설) -->
                    <Button
                        className="bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 border border-amber-500/40 font-medium"
                        disabled={backupRestoring || backupResyncing || backupApplying}
                        onclick={restoreFromBackupNow}
                    >
                        {backupRestoring ? language.sqlBackupRestoringBusy : language.sqlBackupRestoreToMain}
                    </Button>

                    <!-- 백업 해제 -->
                    <Button styled="danger" disabled={backupRemoving || backupResyncing || backupRestoring || backupApplying} onclick={removeBackupConfiguration}>
                        {backupRemoving ? language.postgresApplying : language.sqlBackupRemove}
                    </Button>
                {/if}
            </div>
        {/if}
    </section>
</div>
