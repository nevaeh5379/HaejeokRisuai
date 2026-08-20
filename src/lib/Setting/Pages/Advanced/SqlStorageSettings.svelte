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
        type DbVendor,
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

    onMount(refresh)
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
