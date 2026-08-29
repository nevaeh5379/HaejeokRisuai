<script lang="ts">
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/files/nodeStorage'
    import {
        buildSqlVendorParams,
        isSqlVendorParamsComplete,
        type DbVendor,
        type NodeSqlStorageRuntime,
        type SqlVendorFormValues,
    } from 'src/ts/storage/sql/postgres/nodePostgresStorage'
    import { sqlConfiguredStore } from 'src/ts/stores.svelte'

    type Step = 'welcome' | 'vendor' | 'connection'
    let step = $state<Step>('welcome')

    let selectedVendor = $state<DbVendor | null>(null)
    let migrate = $state(false)
    let busy = $state(false)
    let testing = $state(false)
    let retrying = $state(false)
    let loadingConfig = $state(true)
    let testResult = $state<{ success: boolean; error?: string } | null>(null)
    let runtime = $state<NodeSqlStorageRuntime | null>(null)
    let managedByEnvironment = $state(false)
    let configured = $state(false)

    // PostgreSQL
    let pgConnectionString = $state('')
    let pgPoolMax = $state(10)

    // Oracle
    let oracleUser = $state('')
    let oraclePassword = $state('')
    let oracleTnsAlias = $state('')
    let oracleWalletPath = $state('')
    let oracleWalletPassword = $state('')

    // Azure
    let azureHost = $state('')
    let azureDatabase = $state('')
    let azureUsername = $state('')
    let azurePassword = $state('')
    let azurePort = $state(1433)
    let azurePoolMax = $state(10)

    let recoveryMode = $derived(runtime?.status === 'degraded')

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    function getFormValues(vendor: DbVendor): SqlVendorFormValues {
        return {
            connectionString: pgConnectionString,
            server: azureHost,
            database: azureDatabase,
            user: vendor === 'oracle' ? oracleUser : azureUsername,
            password: vendor === 'oracle' ? oraclePassword : azurePassword,
            tnsAlias: oracleTnsAlias,
            walletPath: oracleWalletPath,
            walletPassword: oracleWalletPassword,
            port: azurePort,
            poolMax: vendor === 'azure' ? azurePoolMax : pgPoolMax,
        }
    }

    function buildParams(vendor: DbVendor): Record<string, unknown> {
        return buildSqlVendorParams(vendor, getFormValues(vendor))
    }

    function isParamsComplete(vendor: DbVendor): boolean {
        return isSqlVendorParamsComplete(vendor, getFormValues(vendor))
    }

    async function testConnection() {
        if (!selectedVendor) {
            alertError(language.sqlSelectVendorFirst)
            return
        }
        if (!isParamsComplete(selectedVendor)) {
            alertError(language.sqlConfigIncomplete)
            return
        }
        testing = true
        testResult = null
        try {
            const result = await getNodeStorage().postgres.testConnection(selectedVendor, buildParams(selectedVendor))
            testResult = result
            if (result.success) {
                alertNormal(language.sqlConnectionSuccess)
            } else {
                alertError(result.error || language.sqlConnectionFailed)
            }
        } catch (error) {
            alertError(error)
        } finally {
            testing = false
        }
    }

    async function applyAndConnect() {
        if (!selectedVendor) {
            alertError(language.sqlSelectVendorFirst)
            return
        }
        if (!isParamsComplete(selectedVendor)) {
            alertError(language.sqlConfigIncomplete)
            return
        }
        busy = true
        try {
            const params = buildParams(selectedVendor)
            await getNodeStorage().postgres.applyDatabaseConfig(selectedVendor, params, recoveryMode ? false : migrate)
            alertNormal(language.postgresApplySuccess)
            sqlConfiguredStore.set(true)
            setTimeout(() => location.reload(), 500)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    async function retryConnection() {
        retrying = true
        try {
            await getNodeStorage().postgres.retryDatabaseConnection()
            alertNormal(language.sqlConnectionSuccess)
            sqlConfiguredStore.set(true)
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            try {
                const config = await getNodeStorage().postgres.getDatabaseConfig()
                runtime = config.runtime ?? null
            } catch {}
        } finally {
            retrying = false
        }
    }

    function populateForm(vendor: DbVendor, params: Record<string, any>) {
        if (vendor === 'postgres') {
            pgConnectionString = params.connectionString || ''
            pgPoolMax = params.poolMax || 10
        } else if (vendor === 'oracle') {
            oracleUser = params.user || ''
            oracleTnsAlias = params.tnsAlias || ''
            oracleWalletPath = params.walletPath || ''
            pgPoolMax = params.poolMax || 10
        } else {
            azureHost = params.server || ''
            azureDatabase = params.database || ''
            azureUsername = params.user || ''
            azurePort = params.port || 1433
            azurePoolMax = params.poolMax || 10
        }
    }

    onMount(async () => {
        try {
            const config = await getNodeStorage().postgres.getDatabaseConfig()
            runtime = config.runtime ?? null
            managedByEnvironment = config.managedByEnvironment
            configured = config.configured
            const vendor = (config.storedVendor || config.vendor) as DbVendor
            if (vendor) {
                selectedVendor = vendor
                populateForm(vendor, config.params || {})
                if (config.configured || config.runtime?.status === 'degraded') {
                    step = 'connection'
                }
            }
            if (config.runtime?.status === 'ready') {
                sqlConfiguredStore.set(true)
                location.reload()
            }
        } catch (error) {
            alertError(error)
        } finally {
            loadingConfig = false
        }
    })
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div class="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-darkborderc bg-bgcolor p-6 text-textcolor shadow-xl">
        <!-- 헤더 -->
        <h2 class="text-xl font-bold">{recoveryMode ? language.sqlRecoveryTitle : language.sqlQuickSetupTitle}</h2>
        <p class="mt-2 text-sm text-textcolor2">
            {recoveryMode ? language.sqlRecoveryDescription : language.sqlQuickSetupDescription}
        </p>

        {#if runtime?.error}
            <div class="mt-4 rounded-lg border border-draculared/50 bg-draculared/10 p-4" role="alert">
                <div class="font-semibold text-draculared">{language.sqlRecoveryConnectionFailed}</div>
                <div class="mt-2 text-sm text-textcolor">{runtime.error.message}</div>
                <div class="mt-1 text-xs text-textcolor2">
                    {language.sqlRecoveryFailedOperation}: {runtime.error.operation}
                </div>
                {#if runtime.error.hint}
                    <div class="mt-2 text-sm text-textcolor2">{runtime.error.hint}</div>
                {/if}
            </div>
        {/if}

        {#if managedByEnvironment}
            <div class="mt-4 rounded-lg border border-borderc bg-darkbg/50 p-4 text-sm text-textcolor2">
                {language.sqlRecoveryEnvironmentManaged}
            </div>
        {/if}

        {#if loadingConfig}
            <div class="mt-6 text-sm text-textcolor2">{language.sqlRecoveryLoading}</div>
        {/if}

        <!-- 단계 1: 환영 -->
        {#if !loadingConfig && step === 'welcome'}
            <div class="mt-6 space-y-4">
                <p class="text-sm text-textcolor2">
                    {language.sqlQuickSetupChooseVendor}
                </p>
                <div class="grid gap-3 sm:grid-cols-3">
                    <button
                        class="rounded-lg border border-darkborderc bg-darkbg p-4 text-left transition hover:border-selected hover:bg-selected/10"
                        onclick={() => { selectedVendor = 'postgres'; step = 'connection' }}
                    >
                        <div class="font-semibold">{language.sqlVendorPostgres}</div>
                        <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorPostgresDesc}</div>
                    </button>
                    <button
                        class="rounded-lg border border-darkborderc bg-darkbg p-4 text-left transition hover:border-selected hover:bg-selected/10"
                        onclick={() => { selectedVendor = 'oracle'; step = 'connection' }}
                    >
                        <div class="font-semibold">{language.sqlVendorOracle}</div>
                        <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorOracleDesc}</div>
                    </button>
                    <button
                        class="rounded-lg border border-darkborderc bg-darkbg p-4 text-left transition hover:border-selected hover:bg-selected/10"
                        onclick={() => { selectedVendor = 'azure'; step = 'connection' }}
                    >
                        <div class="font-semibold">{language.sqlVendorAzure}</div>
                        <div class="mt-1 text-xs text-textcolor2">{language.sqlVendorAzureDesc}</div>
                    </button>
                </div>
            </div>
        {/if}

        <!-- 단계 2: 연결 정보 입력 -->
        {#if !loadingConfig && step === 'connection'}
            <div class="mt-6 space-y-4">
                {#if !configured && !managedByEnvironment}
                    <button class="text-sm text-textcolor2 hover:text-textcolor" onclick={() => step = 'welcome'}>
                        ← {language.sqlQuickSetupChooseVendor}
                    </button>
                {/if}

                <div class="rounded-md border border-borderc bg-darkbg/40 p-2 text-sm font-medium">
                    {selectedVendor === 'postgres' ? language.sqlVendorPostgres :
                     selectedVendor === 'oracle' ? language.sqlVendorOracle :
                     language.sqlVendorAzure}
                </div>

                <fieldset disabled={managedByEnvironment} class="space-y-4 disabled:opacity-60">
                <!-- PostgreSQL 폼 -->
                {#if selectedVendor === 'postgres'}
                    <label class="block text-sm text-textcolor2" for="quick-pg-conn">
                        {language.postgresConnectionString}
                    </label>
                    <TextInput
                        id="quick-pg-conn"
                        bind:value={pgConnectionString}
                        fullwidth={true}
                        placeholder="postgresql://user:password@host:5432/database"
                    />
                    <label class="block text-sm text-textcolor2" for="quick-pg-pool">
                        {language.postgresPoolSize}
                    </label>
                    <NumberInput
                        id="quick-pg-pool"
                        bind:value={pgPoolMax}
                        min={1}
                        max={100}
                        fullwidth={true}
                    />
                {/if}

                <!-- Oracle 폼 -->
                {#if selectedVendor === 'oracle'}
                    <label class="block text-sm text-textcolor2" for="quick-oracle-user">
                        {language.oracleUser}
                    </label>
                    <TextInput id="quick-oracle-user" bind:value={oracleUser} fullwidth={true} />

                    <label class="block text-sm text-textcolor2" for="quick-oracle-pw">
                        {language.oraclePassword}
                    </label>
                    <TextInput id="quick-oracle-pw" bind:value={oraclePassword} hideText={true} fullwidth={true} />

                    <label class="block text-sm text-textcolor2" for="quick-oracle-tns">
                        {language.oracleTnsAlias}
                    </label>
                    <TextInput id="quick-oracle-tns" bind:value={oracleTnsAlias} fullwidth={true} />

                    <label class="block text-sm text-textcolor2" for="quick-oracle-wallet">
                        {language.oracleWalletPath}
                    </label>
                    <TextInput id="quick-oracle-wallet" bind:value={oracleWalletPath} fullwidth={true} />

                    <label class="block text-sm text-textcolor2" for="quick-oracle-walletpw">
                        {language.oracleWalletPassword}
                    </label>
                    <TextInput id="quick-oracle-walletpw" bind:value={oracleWalletPassword} hideText={true} fullwidth={true} />
                {/if}

                <!-- Azure 폼 -->
                {#if selectedVendor === 'azure'}
                    <label class="block text-sm text-textcolor2" for="quick-azure-host">
                        {language.azureHost}
                    </label>
                    <TextInput id="quick-azure-host" bind:value={azureHost} fullwidth={true} placeholder="server.database.windows.net" />

                    <label class="block text-sm text-textcolor2" for="quick-azure-db">
                        {language.azureDatabase}
                    </label>
                    <TextInput id="quick-azure-db" bind:value={azureDatabase} fullwidth={true} />

                    <label class="block text-sm text-textcolor2" for="quick-azure-user">
                        {language.azureUsername}
                    </label>
                    <TextInput id="quick-azure-user" bind:value={azureUsername} fullwidth={true} />

                    <label class="block text-sm text-textcolor2" for="quick-azure-pw">
                        {language.azurePassword}
                    </label>
                    <TextInput id="quick-azure-pw" bind:value={azurePassword} hideText={true} fullwidth={true} />

                    <label class="block text-sm text-textcolor2" for="quick-azure-port">
                        {language.azurePort}
                    </label>
                    <NumberInput id="quick-azure-port" bind:value={azurePort} min={1} max={65535} fullwidth={true} />
                {/if}

                <!-- 마이그레이션 옵션 -->
                {#if !recoveryMode}
                    <div class="mt-4 rounded-md border border-borderc bg-bgcolor/30 p-3">
                        <CheckInput bind:check={migrate} name={language.sqlQuickSetupMigration} />
                        <p class="mt-1 pl-7 text-xs text-textcolor2">{language.sqlQuickSetupMigrationDescription}</p>
                    </div>
                {/if}

                <!-- 버튼 -->
                <div class="flex flex-wrap gap-2 pt-1">
                    <Button disabled={testing} onclick={testConnection}>
                        {testing ? language.sqlTesting : language.sqlTestConnection}
                    </Button>
                    <Button disabled={busy} onclick={applyAndConnect}>
                        {busy ? language.postgresApplying : language.sqlApplyAndConnect}
                    </Button>
                </div>
                </fieldset>

                {#if configured || recoveryMode}
                    <div class="flex flex-wrap gap-2 border-t border-borderc pt-4">
                        <Button disabled={retrying} onclick={retryConnection}>
                            {retrying ? language.sqlRecoveryRetrying : language.sqlRecoveryRetry}
                        </Button>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</div>
