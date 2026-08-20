<script lang="ts">
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import {
        buildSqlVendorParams,
        isSqlVendorParamsComplete,
        type DbVendor,
        type SqlVendorFormValues,
    } from 'src/ts/storage/nodePostgresStorage'
    import { sqlConfiguredStore } from 'src/ts/stores.svelte'
    import { get } from 'svelte/store'

    type Step = 'welcome' | 'vendor' | 'connection'
    let step = $state<Step>('welcome')

    let selectedVendor = $state<DbVendor | null>(null)
    let migrate = $state(true)
    let busy = $state(false)
    let testing = $state(false)
    let testResult = $state<{ success: boolean; error?: string } | null>(null)

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

    let dismissed = $state(false)

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
            await getNodeStorage().postgres.applyDatabaseConfig(selectedVendor, params, migrate)
            alertNormal(language.postgresApplySuccess)
            sqlConfiguredStore.set(true)
            setTimeout(() => location.reload(), 500)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    function skip() {
        dismissed = true
        localStorage.setItem('sqlQuickSetupDismissed', '1')
        alertNormal(language.sqlSetupSkipped)
    }

    onMount(() => {
        if (localStorage.getItem('sqlQuickSetupDismissed') === '1') {
            dismissed = true
        }
        // 이미 설정되어 있으면 표시하지 않음
        const configured = get(sqlConfiguredStore)
        if (configured) {
            dismissed = true
        }
    })
</script>

{#if !dismissed}
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div class="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-darkborderc bg-bgcolor p-6 text-textcolor shadow-xl">
        <!-- 헤더 -->
        <h2 class="text-xl font-bold">{language.sqlQuickSetupTitle}</h2>
        <p class="mt-2 text-sm text-textcolor2">{language.sqlQuickSetupDescription}</p>

        <!-- 단계 1: 환영 -->
        {#if step === 'welcome'}
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
        {#if step === 'connection'}
            <div class="mt-6 space-y-4">
                <button class="text-sm text-textcolor2 hover:text-textcolor" onclick={() => step = 'welcome'}>
                    ← {language.sqlQuickSetupChooseVendor}
                </button>

                <div class="rounded-md border border-borderc bg-darkbg/40 p-2 text-sm font-medium">
                    {selectedVendor === 'postgres' ? language.sqlVendorPostgres :
                     selectedVendor === 'oracle' ? language.sqlVendorOracle :
                     language.sqlVendorAzure}
                </div>

                <!-- PostgreSQL 폼 -->
                {#if selectedVendor === 'postgres'}
                    <label class="block text-sm text-textcolor2" for="quick-pg-conn">
                        {language.postgresConnectionString}
                    </label>
                    <TextInput
                        id="quick-pg-conn"
                        bind:value={pgConnectionString}
                        hideText={true}
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
                <div class="mt-4 rounded-md border border-borderc bg-bgcolor/30 p-3">
                    <CheckInput bind:check={migrate} name={language.sqlQuickSetupMigration} />
                    <p class="mt-1 pl-7 text-xs text-textcolor2">{language.sqlQuickSetupMigrationDescription}</p>
                </div>

                <!-- 버튼 -->
                <div class="flex flex-wrap gap-2">
                    <Button disabled={testing} onclick={testConnection}>
                        {testing ? language.sqlTesting : language.sqlTestConnection}
                    </Button>
                    <Button disabled={busy} onclick={applyAndConnect}>
                        {busy ? language.postgresApplying : language.sqlApplyAndConnect}
                    </Button>
                </div>
            </div>
        {/if}

        <!-- 건너뛰기 (공통) -->
        <div class="mt-6 flex justify-end">
            <Button styled="outlined" onclick={skip}>
                {language.sqlSkipSetup}
            </Button>
        </div>
    </div>
</div>
{/if}
