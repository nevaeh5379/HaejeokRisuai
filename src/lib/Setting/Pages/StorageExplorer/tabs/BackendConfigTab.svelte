<script lang="ts">
    import {
        DatabaseIcon,
        FolderArchiveIcon,
        ServerIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
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
        onSelectBackend: (type: AssetStorageType) => void
        onTestConnection: () => void
        onApplyConfiguration: () => void
        onMigrateToS3: () => void
        onRollbackToLocal: () => void
        onPurgeLocalFs: () => void
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
        onSelectBackend,
        onTestConnection,
        onApplyConfiguration,
        onMigrateToS3,
        onRollbackToLocal,
        onPurgeLocalFs
    }: Props = $props()
</script>

<div class="max-w-3xl space-y-5 sm:space-y-6">
    <!-- Backend Selector: Segment Cards -->
    <div class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs">
        <div class="flex items-center justify-between gap-2">
            <div>
                <h3 class="text-sm sm:text-base font-semibold text-textcolor">{language.storageBackendSelect}</h3>
                <p class="mt-0.5 text-xs text-textcolor2">{language.storageBackendSelectDescription}</p>
            </div>
            {#if config}
                <span class="rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0 {config.enabled ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-darkbutton text-textcolor2'}">
                    {config.storageType === 'azuresql' ? language.storageBackendAzureSql : (config.storageType === 's3' ? language.storageBackendS3 : language.storageBackendLocalFs)}
                </span>
            {/if}
        </div>

        {#if config?.managedByEnvironment}
            <div class="mt-3.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                {language.s3EnvironmentManaged}
            </div>
        {/if}

        <!-- Segment Cards -->
        <div class="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-3">
            <!-- Local FS Card -->
            <button
                type="button"
                class="flex flex-col items-start rounded-xl border p-3.5 sm:p-4 text-left transition-all cursor-pointer {storageType === 'fs' ? 'border-indigo-500 bg-indigo-500/10 ring-1 ring-indigo-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config?.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                onclick={() => onSelectBackend('fs')}
                disabled={config?.managedByEnvironment}
            >
                <div class="flex items-center gap-2">
                    <FolderArchiveIcon class="h-4 w-4 sm:h-5 sm:w-5 text-indigo-400 shrink-0" />
                    <span class="text-xs sm:text-sm font-semibold text-textcolor">{language.storageBackendLocalFs}</span>
                </div>
                <p class="mt-1.5 text-[11px] text-textcolor2">{language.storageBackendFsDesc}</p>
            </button>

            <!-- S3 Card -->
            <button
                type="button"
                class="flex flex-col items-start rounded-xl border p-3.5 sm:p-4 text-left transition-all cursor-pointer {storageType === 's3' ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config?.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                onclick={() => onSelectBackend('s3')}
                disabled={config?.managedByEnvironment}
            >
                <div class="flex items-center gap-2">
                    <ServerIcon class="h-4 w-4 sm:h-5 sm:w-5 text-blue-400 shrink-0" />
                    <span class="text-xs sm:text-sm font-semibold text-textcolor">{language.storageBackendS3}</span>
                </div>
                <p class="mt-1.5 text-[11px] text-textcolor2">{language.storageBackendS3Desc}</p>
            </button>

            <!-- Azure SQL Card -->
            <button
                type="button"
                class="flex flex-col items-start rounded-xl border p-3.5 sm:p-4 text-left transition-all cursor-pointer {storageType === 'azuresql' ? 'border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'} {config?.azureManagedByEnvironment ? 'pointer-events-none opacity-60' : ''}"
                onclick={() => onSelectBackend('azuresql')}
                disabled={config?.azureManagedByEnvironment}
            >
                <div class="flex items-center gap-2">
                    <DatabaseIcon class="h-4 w-4 sm:h-5 sm:w-5 text-sky-400 shrink-0" />
                    <span class="text-xs sm:text-sm font-semibold text-textcolor">{language.storageBackendAzureSql}</span>
                </div>
                <p class="mt-1.5 text-[11px] text-textcolor2">{language.storageBackendAzureSqlDesc}</p>
            </button>
        </div>
    </div>

    <!-- S3 Config Form -->
    {#if storageType === 's3'}
        <div class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs">
            <h4 class="text-sm font-semibold text-textcolor">{language.storageConnectionSettings}</h4>

            <div class="mt-4 grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
                    />
                </div>
            </div>

            <div class="mt-4 flex flex-col gap-2">
                <CheckInput bind:check={forcePathStyle} name={language.s3ForcePathStyle} />
                <CheckInput bind:check={autoCreateBucket} name={language.s3AutoCreateBucket} />
            </div>

            {#if !config?.managedByEnvironment}
                <div class="mt-6 flex flex-wrap items-center gap-2.5 sm:gap-3">
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
        <div class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs">
            <h4 class="text-sm font-semibold text-textcolor">{language.storageAzureSqlConnectionSettings}</h4>

            {#if config?.azureManagedByEnvironment}
                <p class="mt-3 rounded-md border border-borderc bg-bgcolor/40 p-2 text-xs text-textcolor2">
                    {language.azureSqlManagedByEnv}
                </p>
            {/if}

            <div class="mt-4 grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
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
                        className="mt-1 text-xs"
                    />
                </div>
            </div>

            {#if !config?.azureManagedByEnvironment}
                <div class="mt-6 flex flex-wrap items-center gap-2.5 sm:gap-3">
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
        <div class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs">
            <h4 class="text-sm font-semibold text-textcolor">{language.storageBackendLocalFs}</h4>
            <p class="mt-1 text-xs text-textcolor2">{language.storageBackendFsDesc}</p>

            {#if !config?.managedByEnvironment}
                <div class="mt-6 flex flex-wrap items-center gap-2.5 sm:gap-3">
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
    <div class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-5 shadow-xs">
        <h4 class="text-sm font-semibold text-textcolor">{language.s3StatsAndTools}</h4>
        <p class="mt-1 text-xs text-textcolor2">{language.s3StatsAndToolsDescription}</p>

        <div class="mt-4 flex flex-wrap items-center gap-2.5 sm:gap-3">
            <Button disabled={migrating || !config?.enabled} onclick={onMigrateToS3}>
                {migrating ? language.s3Migrating : (config?.storageType === 'azuresql' ? language.azureSqlStorageMigrateFromLocal : language.s3MigrateFromLocal)}
            </Button>

            <Button disabled={rollingBack || !config?.enabled} onclick={onRollbackToLocal}>
                {rollingBack ? language.s3RollingBack : (config?.storageType === 'azuresql' ? language.azureSqlStorageRollbackToLocal : language.s3RollbackToLocal)}
            </Button>

            {#if config?.enabled && (storageSummary?.localFs?.totalObjects ?? 0) > 0}
                <Button
                    className="bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 border border-rose-500/40"
                    disabled={purgingLocal || busy}
                    onclick={onPurgeLocalFs}
                >
                    {purgingLocal ? language.storagePurging : language.storagePurgeLocalFs}
                </Button>
            {/if}
        </div>
    </div>
</div>
