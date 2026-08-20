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
        type NodeBackupFullSyncResult,
        type NodePostgresRevision,
        type NodePostgresServerConfig,
        type NodePostgresTokenUsage,
        type SqlVendorFormValues,
    } from 'src/ts/storage/nodePostgresStorage'
    import { encodeRisuSaveLegacy } from 'src/ts/storage/risuSave'

    let config = $state<NodePostgresServerConfig|null>(null)
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

    // PostgreSQL 레거시 호환 폼 상태
    let enabled = $state(false)
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

    // 범용 폼 poolMax (oracle/azure 공통)
    let vendorPoolMax = $state(10)

    let busy = $state(false)
    let loadError = $state('')
    let revisions = $state<NodePostgresRevision[]>([])
    let tokenUsage = $state<NodePostgresTokenUsage[]>([])

    // ── 백업 데이터베이스 상태 ──
    let backup = $state<NodeBackupConfig | null>(null)
    let backupLoadError = $state('')
    let backupTesting = $state(false)
    let backupResyncing = $state(false)
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
        if(!(forageStorage.realStorage instanceof NodeStorage)){
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function refresh() {
        busy = true
        loadError = ''
        try {
            const storage = getNodeStorage()
            // 레거시 /api/postgres-config (호환성)
            config = await storage.postgres.getServerConfig()
            enabled = config.enabled
            poolMax = config.poolMax
            // 범용 /api/db-config
            try {
                dbConfig = await storage.postgres.getDatabaseConfig()
                vendorPoolMax = dbConfig.params?.poolMax || 10
                // vendor별 폼 채우기 (마스킹된 값은 그대로 표시, 비밀번호는 빈 칸)
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
                    }
                }
            } catch (e) {
                // /api/db-config 미지원 서버일 수 있음 - 레거시 폼으로 폴백
            }
            revisions = config.enabled ? await storage.postgres.listRevisions(20) : []
            tokenUsage = config.enabled ? await storage.postgres.getTokenUsage() : []
        } catch (error) {
            loadError = `${error}`
        } finally {
            busy = false
        }
    }

    async function restoreRevision(revision:NodePostgresRevision) {
        if(busy || !await alertConfirm(language.postgresRestoreConfirm(revision.id))){
            return
        }
        busy = true
        try {
            await getNodeStorage().postgres.restoreRevision(revision.id)
            alertNormal(language.postgresRestoreSuccess)
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
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

    // vendor별 라벨/설명
    const vendorLabel = $derived(
        config?.vendor === 'oracle' ? language.sqlVendorOracle :
        config?.vendor === 'azure' ? language.sqlVendorAzure :
        language.sqlVendorPostgres
    )

    async function applyConfiguration() {
        if(!config || config.managedByEnvironment || busy){
            return
        }
        const vendor: DbVendor = config.vendor || 'postgres'
        const params = buildParams(vendor)

        // 비밀번호 필드가 빈 값이면 기존 비밀번호 유지 안 됨 - 사용자가 다시 입력해야 함
        // (보안: 마스킹된 값을 클라이언트에 내려주지 않으므로)

        if(!await alertConfirm(language.postgresApplyConfirm)){
            return
        }

        busy = true
        try {
            const storage = getNodeStorage()
            // 로컬 database.bin 스냅샷 준비 (레거시 호환)
            let legacySnapshotReady = false
            if(config.enabled){
                const snapshot = encodeRisuSaveLegacy(
                    getDatabase({ snapshot: true }),
                    'compression'
                )
                await storage.setItem('database/database.bin', snapshot)
                legacySnapshotReady = true
            }

            // 범용 API가 있으면 사용, 없으면 레거시 configureServer로 폴백
            try {
                await storage.postgres.applyDatabaseConfig(vendor, params, false)
            } catch (e) {
                // 폴백: PostgreSQL 레거시 API
                if (vendor === 'postgres') {
                    await storage.postgres.configureServer({
                        enabled,
                        connectionString: connectionString.trim() || undefined,
                        poolMax,
                        legacySnapshotReady,
                    })
                } else {
                    throw e
                }
            }
            alertNormal(language.postgresApplySuccess)
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    async function testConnection() {
        if(busy || !config){
            return
        }
        const vendor: DbVendor = config.vendor || 'postgres'
        const params = buildParams(vendor)
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
            // /api/db-backup 미지원(구버전) 서버일 수 있음
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
            const result = await getNodeStorage().postgres.resyncBackup((event) => {
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

    const backupVendorLabel = $derived(
        backupVendor === 'oracle' ? language.sqlVendorOracle :
        backupVendor === 'azure' ? language.sqlVendorAzure :
        backupVendor === 'postgres' ? language.sqlVendorPostgres :
        ''
    )

    function formatBackupTime(value: string | null | undefined) {
        if (!value) return language.sqlBackupNever
        return new Date(value).toLocaleString()
    }

    onMount(() => {
        refresh()
        refreshBackup()
    })
</script>

<section class="mt-5 rounded-lg border border-darkborderc bg-darkbg/40 p-4 text-textcolor">
    <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
            <h3 class="text-base font-semibold">{language.sqlStorage}</h3>
            <p class="mt-1 text-sm text-textcolor2">{language.sqlStorageDescription}</p>
        </div>
        <div class="flex items-center gap-2">
            {#if config?.vendor}
                <span class="rounded-full bg-bgcolor/60 px-2 py-1 text-xs text-textcolor2">
                    {vendorLabel}
                </span>
            {/if}
            {#if config}
                <span class="rounded-full px-2 py-1 text-xs {config.enabled ? 'bg-selected text-textcolor' : 'bg-darkbutton text-textcolor2'}">
                    {config.enabled ? language.postgresStatusEnabled : language.postgresStatusDisabled}
                </span>
            {/if}
        </div>
    </div>

    {#if loadError}
        <p class="mt-3 rounded-md border border-draculared/50 bg-draculared/10 p-2 text-sm text-draculared">{loadError}</p>
    {:else if !config}
        <p class="mt-3 text-sm text-textcolor2">{language.postgresStatusLoading}</p>
    {:else}
        {#if config.managedByEnvironment}
            <p class="mt-3 rounded-md border border-borderc bg-bgcolor/40 p-2 text-sm text-textcolor2">
                {language.postgresEnvironmentManaged}
            </p>
        {/if}

        <div class="mt-4 {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}">
            <CheckInput bind:check={enabled} name={language.useSqlStorage} />
        </div>

        <!-- ── PostgreSQL 폼 ── -->
        {#if config.vendor === 'postgres' || !config.vendor}
            <label class="mt-4 block text-sm text-textcolor2" for="postgres-connection-string">
                {language.postgresConnectionString}
            </label>
            <TextInput
                id="postgres-connection-string"
                bind:value={connectionString}
                hideText={true}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                placeholder={config.connectionDisplay || 'postgresql://user:password@host:5432/database'}
                className="mt-1"
            />
            <p class="mt-1 text-xs text-textcolor2">{language.postgresConnectionSecurity}</p>

            <label class="mt-4 block text-sm text-textcolor2" for="postgres-pool-size">
                {language.postgresPoolSize}
            </label>
            <NumberInput
                id="postgres-pool-size"
                bind:value={poolMax}
                min={1}
                max={100}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />
        {/if}

        <!-- ── Oracle 폼 ── -->
        {#if config.vendor === 'oracle'}
            <label class="mt-4 block text-sm text-textcolor2" for="oracle-user">
                {language.oracleUser}
            </label>
            <TextInput
                id="oracle-user"
                bind:value={oracleUser}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="oracle-password">
                {language.oraclePassword}
            </label>
            <TextInput
                id="oracle-password"
                bind:value={oraclePassword}
                hideText={true}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="oracle-tns-alias">
                {language.oracleTnsAlias}
            </label>
            <TextInput
                id="oracle-tns-alias"
                bind:value={oracleTnsAlias}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="oracle-wallet-path">
                {language.oracleWalletPath}
            </label>
            <TextInput
                id="oracle-wallet-path"
                bind:value={oracleWalletPath}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="oracle-wallet-password">
                {language.oracleWalletPassword}
            </label>
            <TextInput
                id="oracle-wallet-password"
                bind:value={oracleWalletPassword}
                hideText={true}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="oracle-pool-size">
                {language.postgresPoolSize}
            </label>
            <NumberInput
                id="oracle-pool-size"
                bind:value={vendorPoolMax}
                min={1}
                max={100}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />
        {/if}

        <!-- ── Azure 폼 ── -->
        {#if config.vendor === 'azure'}
            <label class="mt-4 block text-sm text-textcolor2" for="azure-host">
                {language.azureHost}
            </label>
            <TextInput
                id="azure-host"
                bind:value={azureHost}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                placeholder="server.database.windows.net"
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="azure-database">
                {language.azureDatabase}
            </label>
            <TextInput
                id="azure-database"
                bind:value={azureDatabase}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="azure-username">
                {language.azureUsername}
            </label>
            <TextInput
                id="azure-username"
                bind:value={azureUsername}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="azure-password">
                {language.azurePassword}
            </label>
            <TextInput
                id="azure-password"
                bind:value={azurePassword}
                hideText={true}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="azure-port">
                {language.azurePort}
            </label>
            <NumberInput
                id="azure-port"
                bind:value={azurePort}
                min={1}
                max={65535}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />

            <label class="mt-4 block text-sm text-textcolor2" for="azure-pool-size">
                {language.postgresPoolSize}
            </label>
            <NumberInput
                id="azure-pool-size"
                bind:value={vendorPoolMax}
                min={1}
                max={100}
                fullwidth={true}
                disabled={config.managedByEnvironment}
                className="mt-1"
            />
        {/if}

        {#if config.enabled}
            <p class="mt-3 text-xs text-textcolor2">
                {language.postgresRevision}: {config.revision ?? 0} · {config.initialized ? language.postgresInitialized : language.postgresWaitingMigration}
            </p>
        {/if}

        {#if !config.managedByEnvironment}
            <div class="mt-4 flex flex-wrap gap-2">
                <Button disabled={busy} onclick={testConnection}>
                    {busy ? language.sqlTesting : language.sqlTestConnection}
                </Button>
                <Button disabled={busy} onclick={applyConfiguration}>
                    {busy ? language.postgresApplying : language.postgresApply}
                </Button>
            </div>
        {/if}

        {#if config.enabled}
            <div class="mt-5 border-t border-darkborderc pt-4">
                <h4 class="text-sm font-semibold">{language.postgresTokenUsage}</h4>
                <p class="mt-1 text-xs text-textcolor2">{language.postgresTokenUsageDescription}</p>
                {#if tokenUsage.length === 0}
                    <p class="mt-3 text-sm text-textcolor2">{language.postgresTokenUsageEmpty}</p>
                {:else}
                    <div class="mt-3 max-h-72 space-y-2 overflow-y-auto">
                        {#each tokenUsage as usage}
                            <div class="flex items-center justify-between gap-3 rounded-md border border-darkborderc bg-bgcolor/30 p-2">
                                <div class="min-w-0 text-xs">
                                    <div class="font-medium text-textcolor">{usage.model}</div>
                                    <div class="mt-0.5 text-textcolor2">
                                        {usage.messageCount} {language.postgresTokenUsageMessages}
                                    </div>
                                </div>
                                <div class="text-right text-xs text-textcolor2">
                                    <div>{language.postgresTokenUsageInput}: {usage.totalInputTokens.toLocaleString()}</div>
                                    <div>{language.postgresTokenUsageOutput}: {usage.totalOutputTokens.toLocaleString()}</div>
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="mt-5 border-t border-darkborderc pt-4">
                <h4 class="text-sm font-semibold">{language.postgresHistory}</h4>
                <p class="mt-1 text-xs text-textcolor2">{language.postgresHistoryDescription}</p>
                {#if revisions.length === 0}
                    <p class="mt-3 text-sm text-textcolor2">{language.postgresHistoryEmpty}</p>
                {:else}
                    <div class="mt-3 max-h-72 space-y-2 overflow-y-auto">
                        {#each revisions as revision}
                            <div class="flex items-center justify-between gap-3 rounded-md border border-darkborderc bg-bgcolor/30 p-2">
                                <div class="min-w-0 text-xs">
                                    <div class="font-medium text-textcolor">
                                        #{revision.id} · {revision.scope} / {revision.action}
                                    </div>
                                    <div class="mt-0.5 text-textcolor2">
                                        {new Date(revision.created_at).toLocaleString()} · {revision.change_count} {language.postgresHistoryChanges}
                                    </div>
                                </div>
                                <Button disabled={busy || revision.id === revisions[0]?.id} onclick={() => restoreRevision(revision)}>
                                    {language.postgresRestore}
                                </Button>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>
        {/if}
    {/if}
</section>

<!-- ─────────────────────────────────────────────────────────────
     백업 데이터베이스
──────────────────────────────────────────────────────────── -->
<section class="mt-5 rounded-lg border border-darkborderc bg-darkbg/40 p-4 text-textcolor">
    <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
            <h3 class="text-base font-semibold">{language.sqlBackupTitle}</h3>
            <p class="mt-1 text-sm text-textcolor2">{language.sqlBackupDescription}</p>
        </div>
        {#if backup}
            <span class="rounded-full px-2 py-1 text-xs {backup.enabled ? 'bg-selected text-textcolor' : 'bg-darkbutton text-textcolor2'}">
                {backup.enabled ? language.sqlBackupStatusEnabled : language.sqlBackupStatusDisabled}
            </span>
        {/if}
    </div>

    {#if backupLoadError}
        <p class="mt-3 rounded-md border border-draculared/50 bg-draculared/10 p-2 text-sm text-draculared">{backupLoadError}</p>
    {:else if backup === null}
        <p class="mt-3 text-sm text-textcolor2">{language.sqlBackupNotConfigured}</p>
    {:else}
        <!-- 제공자 선택 -->
        <p class="mt-4 text-sm font-medium">{language.sqlBackupChooseVendor}</p>
        <div class="mt-2 grid gap-2 sm:grid-cols-3">
            <button
                class="rounded-lg border p-3 text-left transition {backupVendor === 'postgres' ? 'border-selected bg-selected/10' : 'border-darkborderc bg-darkbg hover:border-selected hover:bg-selected/10'}"
                onclick={() => backupVendor = 'postgres'}
            >
                <div class="text-sm font-semibold">{language.sqlVendorPostgres}</div>
                <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorPostgresDesc}</div>
            </button>
            <button
                class="rounded-lg border p-3 text-left transition {backupVendor === 'oracle' ? 'border-selected bg-selected/10' : 'border-darkborderc bg-darkbg hover:border-selected hover:bg-selected/10'}"
                onclick={() => backupVendor = 'oracle'}
            >
                <div class="text-sm font-semibold">{language.sqlVendorOracle}</div>
                <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorOracleDesc}</div>
            </button>
            <button
                class="rounded-lg border p-3 text-left transition {backupVendor === 'azure' ? 'border-selected bg-selected/10' : 'border-darkborderc bg-darkbg hover:border-selected hover:bg-selected/10'}"
                onclick={() => backupVendor = 'azure'}
            >
                <div class="text-sm font-semibold">{language.sqlVendorAzure}</div>
                <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorAzureDesc}</div>
            </button>
        </div>

        <!-- 연결 정보 폼 (vendor별) -->
        {#if backupVendor === 'postgres'}
            <label class="mt-4 block text-sm text-textcolor2" for="backup-pg-connection-string">
                {language.postgresConnectionString}
            </label>
            <TextInput
                id="backup-pg-connection-string"
                bind:value={backupPgConnectionString}
                hideText={true}
                fullwidth={true}
                placeholder="postgresql://user:password@host:5432/database"
                className="mt-1"
            />
        {:else if backupVendor === 'oracle'}
            <label class="mt-4 block text-sm text-textcolor2" for="backup-oracle-user">{language.oracleUser}</label>
            <TextInput id="backup-oracle-user" bind:value={backupOracleUser} fullwidth={true} className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-oracle-password">{language.oraclePassword}</label>
            <TextInput id="backup-oracle-password" bind:value={backupOraclePassword} hideText={true} fullwidth={true} className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-oracle-tns">{language.oracleTnsAlias}</label>
            <TextInput id="backup-oracle-tns" bind:value={backupOracleTnsAlias} fullwidth={true} className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-oracle-wallet">{language.oracleWalletPath}</label>
            <TextInput id="backup-oracle-wallet" bind:value={backupOracleWalletPath} fullwidth={true} className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-oracle-wallet-password">{language.oracleWalletPassword}</label>
            <TextInput id="backup-oracle-wallet-password" bind:value={backupOracleWalletPassword} hideText={true} fullwidth={true} className="mt-1" />
        {:else if backupVendor === 'azure'}
            <label class="mt-4 block text-sm text-textcolor2" for="backup-azure-host">{language.azureHost}</label>
            <TextInput id="backup-azure-host" bind:value={backupAzureHost} fullwidth={true} placeholder="server.database.windows.net" className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-azure-database">{language.azureDatabase}</label>
            <TextInput id="backup-azure-database" bind:value={backupAzureDatabase} fullwidth={true} className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-azure-username">{language.azureUsername}</label>
            <TextInput id="backup-azure-username" bind:value={backupAzureUsername} fullwidth={true} className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-azure-password">{language.azurePassword}</label>
            <TextInput id="backup-azure-password" bind:value={backupAzurePassword} hideText={true} fullwidth={true} className="mt-1" />

            <label class="mt-4 block text-sm text-textcolor2" for="backup-azure-port">{language.azurePort}</label>
            <NumberInput id="backup-azure-port" bind:value={backupAzurePort} min={1} max={65535} fullwidth={true} className="mt-1" />
        {/if}

        {#if backupVendor}
            <label class="mt-4 block text-sm text-textcolor2" for="backup-pool-size">{language.postgresPoolSize}</label>
            <NumberInput id="backup-pool-size" bind:value={backupPoolMax} min={1} max={100} fullwidth={true} className="mt-1" />
        {/if}

        <!-- 백업 옵션 -->
        <div class="mt-4 rounded-md border border-borderc bg-bgcolor/30 p-3">
            <CheckInput bind:check={backupMirroring} name={language.sqlBackupMirroring} />
            <p class="mt-1 pl-7 text-xs text-textcolor2">{language.sqlBackupMirroringDescription}</p>
            <div class="mt-3">
                <CheckInput bind:check={backupSnapshotEnabled} name={language.sqlBackupSnapshot} />
                <p class="mt-1 pl-7 text-xs text-textcolor2">{language.sqlBackupSnapshotDescription}</p>
            </div>
            {#if backupSnapshotEnabled}
                <div class="mt-3 pl-7">
                    <label class="block text-sm text-textcolor2" for="backup-snapshot-interval">
                        {language.sqlBackupSnapshotInterval}
                    </label>
                    <NumberInput
                        id="backup-snapshot-interval"
                        bind:value={backupSnapshotInterval}
                        min={5}
                        max={1440}
                        fullwidth={true}
                        className="mt-1"
                    />
                </div>
            {/if}
        </div>

        <!-- 상태 (설정됨) -->
        {#if backup.configured}
            <div class="mt-4 rounded-md border border-borderc bg-bgcolor/30 p-3 text-xs text-textcolor2">
                <div class="flex flex-wrap gap-x-6 gap-y-1">
                    <span>{language.sqlBackupPrimaryRevision}: {backup.primaryRevision ?? '—'}</span>
                    <span>{language.sqlBackupBackupRevision}: {backup.backupRevision ?? '—'}</span>
                    {#if backup.lag !== null}
                        <span class="flex items-center gap-1">
                            {language.sqlBackupLag}:
                            <span class={backup.lag > 0 ? 'text-draculared' : 'text-textcolor'}>{backup.lag}</span>
                        </span>
                    {/if}
                </div>
                <div class="mt-2 space-y-0.5">
                    <p>{language.sqlBackupLastMirror}: {formatBackupTime(backup.lastMirrorAt)}</p>
                    <p>{language.sqlBackupLastSnapshot}: {formatBackupTime(backup.lastSnapshotAt)}</p>
                    <p>{language.sqlBackupLastFullSync}: {formatBackupTime(backup.lastFullSyncAt)}</p>
                </div>
                {#if backup.inFlight && !backupResyncing}
                    <p class="mt-2 text-textcolor">{language.sqlBackupInProgress}</p>
                {/if}
                {#if backup.lastMirrorError}
                    <p class="mt-2 text-draculared">{language.sqlBackupLastError}: {backup.lastMirrorError}</p>
                {/if}
                {#if backup.lastSnapshotError}
                    <p class="mt-2 text-draculared">{language.sqlBackupLastError}: {backup.lastSnapshotError}</p>
                {/if}
                {#if backup.lastFullSyncError}
                    <p class="mt-2 text-draculared">{language.sqlBackupLastError}: {backup.lastFullSyncError}</p>
                {/if}
            </div>
        {/if}

        <!-- 실시간 백업 진행 상황 표시 -->
        {#if backupResyncing && backupProgressData}
            <div class="mt-4 rounded-lg border border-selected/40 bg-selected/10 p-4 text-textcolor shadow-md transition-all duration-300">
                <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2">
                        <svg class="h-4 w-4 animate-spin text-selected" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                        </svg>
                        <span class="text-sm font-semibold text-textcolor">
                            {#if backupProgressData.stage === 'reading'}
                                {language.sqlBackupProgressReading}
                            {:else if backupProgressData.stage === 'preparing'}
                                {language.sqlBackupProgressPreparing}
                            {:else if backupProgressData.stage === 'connecting'}
                                {language.sqlBackupProgressConnecting}
                            {:else if backupProgressData.stage === 'settings'}
                                {language.sqlBackupProgressSettings}
                            {:else if backupProgressData.stage === 'characters'}
                                {language.sqlBackupProgressCharacters}
                            {:else if backupProgressData.stage === 'chats'}
                                {language.sqlBackupProgressChats}
                            {:else if backupProgressData.stage === 'messages'}
                                {language.sqlBackupProgressMessages}
                            {:else if backupProgressData.stage === 'finalizing'}
                                {language.sqlBackupProgressFinalizing}
                            {:else if backupProgressData.stage === 'done'}
                                {language.sqlBackupProgressDone}
                            {:else}
                                {backupProgressData.message || language.sqlBackupInProgress}
                            {/if}
                        </span>
                    </div>
                    <span class="text-sm font-bold text-selected">
                        {backupProgressData.percentage ?? 0}%
                    </span>
                </div>

                <!-- Progress bar track -->
                <div class="mt-3 h-2.5 w-full overflow-hidden rounded-full border border-darkborderc bg-bgcolor/50">
                    <div
                        class="h-full bg-selected transition-all duration-300"
                        style="width: {backupProgressData.percentage ?? 0}%"
                    ></div>
                </div>

                <!-- Details / Stats -->
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

        <!-- 버튼 -->
        <div class="mt-4 flex flex-wrap gap-2">
            <Button disabled={backupTesting || backupApplying || !backupVendor} onclick={testBackupConnection}>
                {backupTesting ? language.sqlTesting : language.sqlTestConnection}
            </Button>
            <Button disabled={backupApplying || backupResyncing || !backupVendor} onclick={applyBackupConfiguration}>
                {backupApplying ? language.postgresApplying : language.sqlBackupApply}
            </Button>
            {#if backup.configured}
                <Button disabled={backupResyncing || backupApplying} onclick={resyncBackupNow}>
                    {backupResyncing ? language.sqlBackupResyncBusy : language.sqlBackupResync}
                </Button>
                <Button styled="danger" disabled={backupRemoving || backupResyncing || backupApplying} onclick={removeBackupConfiguration}>
                    {backupRemoving ? language.postgresApplying : language.sqlBackupRemove}
                </Button>
            {/if}
        </div>
    {/if}
</section>
