<script lang="ts">
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import type { NodeS3ProgressEvent, NodeS3ServerConfig, NodeS3Stats } from 'src/ts/storage/nodeS3Storage'

    let config = $state<NodeS3ServerConfig | null>(null)
    let enabled = $state(false)
    let endpoint = $state('')
    let bucket = $state('risuai-assets')
    let region = $state('us-east-1')
    let accessKeyId = $state('')
    let secretAccessKey = $state('')
    let forcePathStyle = $state(true)
    let autoCreateBucket = $state(true)

    let busy = $state(false)
    let loadError = $state('')
    let stats = $state<NodeS3Stats | null>(null)
    let testingConnection = $state(false)
    let migrating = $state(false)
    let rollingBack = $state(false)
    let generatingThumbnails = $state(false)
    let activeTask = $state<'migrate' | 'rollback' | 'thumbnails' | null>(null)
    let progressData = $state<NodeS3ProgressEvent | null>(null)

    function getNodeStorage() {
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

    async function refresh() {
        busy = true
        loadError = ''
        try {
            const storage = getNodeStorage()
            config = await storage.s3.getServerConfig()
            enabled = config.enabled
            endpoint = config.endpoint || ''
            bucket = config.bucket || 'risuai-assets'
            region = config.region || 'us-east-1'
            forcePathStyle = config.forcePathStyle
            autoCreateBucket = config.autoCreateBucket
            accessKeyId = config.accessKeyId || ''
            
            try {
                stats = await storage.s3.getStats()
            } catch (err) {
                // Ignore stats load error if not accessible
            }
        } catch (error) {
            loadError = `${error}`
        } finally {
            busy = false
        }
    }

    async function testConnection() {
        testingConnection = true
        try {
            const storage = getNodeStorage()
            const result = await storage.s3.testConnection({
                enabled: true,
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
        } catch (error) {
            alertError(error)
        } finally {
            testingConnection = false
        }
    }

    async function applyConfiguration() {
        if (!config || config.managedByEnvironment || busy) {
            return
        }
        if (!await alertConfirm(language.s3ApplyConfirm)) {
            return
        }

        busy = true
        try {
            const storage = getNodeStorage()
            await storage.s3.configureServer({
                enabled,
                endpoint: endpoint.trim(),
                bucket: bucket.trim(),
                region: region.trim(),
                accessKeyId: accessKeyId.trim() || undefined,
                secretAccessKey: secretAccessKey.trim() || undefined,
                forcePathStyle,
                autoCreateBucket
            })
            alertNormal(language.s3ApplySuccess)
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    async function migrateToS3() {
        if (!config?.enabled) {
            alertError(language.s3MustBeEnabledToMigrate)
            return
        }
        if (!await alertConfirm(language.s3MigrateConfirm)) {
            return
        }

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
            await refresh()
        } catch (error) {
            alertError(error)
        } finally {
            migrating = false
            activeTask = null
            progressData = null
        }
    }

    async function rollbackToLocal() {
        if (!await alertConfirm(language.s3RollbackConfirm)) {
            return
        }

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
            await refresh()
        } catch (error) {
            alertError(error)
        } finally {
            rollingBack = false
            activeTask = null
            progressData = null
        }
    }

    async function generateThumbnails() {
        if (!config?.enabled) {
            alertError(language.s3MustBeEnabledToMigrate)
            return
        }
        if (!await alertConfirm(language.s3GenerateThumbnailsConfirm)) {
            return
        }

        generatingThumbnails = true
        activeTask = 'thumbnails'
        progressData = {
            type: 'progress',
            current: 0,
            total: 0,
            percentage: 0,
            created: 0,
            skipped: 0
        }

        try {
            const storage = getNodeStorage()
            const result = await storage.s3.generateMissingThumbnails((event) => {
                progressData = event
            })
            alertNormal(language.s3GenerateThumbnailsSuccess(result.created, result.skipped, result.total))
            await refresh()
        } catch (error) {
            alertError(error)
        } finally {
            generatingThumbnails = false
            activeTask = null
            progressData = null
        }
    }

    onMount(refresh)
</script>

<section class="mt-5 rounded-lg border border-darkborderc bg-darkbg/40 p-4 text-textcolor">
    <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
            <h3 class="text-base font-semibold">{language.s3Storage}</h3>
            <p class="mt-1 text-sm text-textcolor2">{language.s3StorageDescription}</p>
        </div>
        {#if config}
            <div class="flex items-center gap-2">
                <span class="rounded-full px-2.5 py-0.5 text-xs {config.enabled ? 'bg-selected text-textcolor font-medium' : 'bg-darkbutton text-textcolor2'}">
                    {config.enabled ? 'S3 / RustFS' : language.s3StatusLocalFs}
                </span>
            </div>
        {/if}
    </div>

    {#if loadError}
        <p class="mt-3 rounded-md border border-draculared/50 bg-draculared/10 p-2 text-sm text-draculared">{loadError}</p>
    {:else if !config}
        <p class="mt-3 text-sm text-textcolor2">{language.s3StatusLoading}</p>
    {:else}
        {#if config.managedByEnvironment}
            <p class="mt-3 rounded-md border border-borderc bg-bgcolor/40 p-2 text-sm text-textcolor2">
                {language.s3EnvironmentManaged}
            </p>
        {/if}

        <div class="mt-4 {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}">
            <CheckInput bind:check={enabled} name={language.useS3Storage} />
        </div>

        <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
                <label class="block text-sm text-textcolor2" for="s3-endpoint">
                    {language.s3Endpoint}
                </label>
                <TextInput
                    id="s3-endpoint"
                    bind:value={endpoint}
                    fullwidth={true}
                    disabled={config.managedByEnvironment}
                    placeholder="http://127.0.0.1:9000 (RustFS / MinIO)"
                    className="mt-1"
                />
                <p class="mt-1 text-xs text-textcolor2">{language.s3EndpointHint}</p>
            </div>

            <div>
                <label class="block text-sm text-textcolor2" for="s3-bucket">
                    {language.s3Bucket}
                </label>
                <TextInput
                    id="s3-bucket"
                    bind:value={bucket}
                    fullwidth={true}
                    disabled={config.managedByEnvironment}
                    placeholder="risuai-assets"
                    className="mt-1"
                />
            </div>
        </div>

        <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
                <label class="block text-sm text-textcolor2" for="s3-access-key">
                    {language.s3AccessKeyId}
                </label>
                <TextInput
                    id="s3-access-key"
                    bind:value={accessKeyId}
                    fullwidth={true}
                    disabled={config.managedByEnvironment}
                    placeholder="rustfsadmin"
                    className="mt-1"
                />
            </div>

            <div>
                <label class="block text-sm text-textcolor2" for="s3-secret-key">
                    {language.s3SecretAccessKey}
                </label>
                <TextInput
                    id="s3-secret-key"
                    bind:value={secretAccessKey}
                    hideText={true}
                    fullwidth={true}
                    disabled={config.managedByEnvironment}
                    placeholder={config.hasSecretAccessKey ? '•••••••••••• (저장됨 / 변경 시 입력)' : 'rustfsadmin'}
                    className="mt-1"
                />
            </div>
        </div>

        <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
                <label class="block text-sm text-textcolor2" for="s3-region">
                    {language.s3Region}
                </label>
                <TextInput
                    id="s3-region"
                    bind:value={region}
                    fullwidth={true}
                    disabled={config.managedByEnvironment}
                    placeholder="us-east-1"
                    className="mt-1"
                />
            </div>

            <div class="flex items-center pt-6 {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}">
                <CheckInput bind:check={forcePathStyle} name={language.s3ForcePathStyle} />
            </div>

            <div class="flex items-center pt-6 {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}">
                <CheckInput bind:check={autoCreateBucket} name={language.s3AutoCreateBucket} />
            </div>
        </div>

        {#if !config.managedByEnvironment}
            <div class="mt-5 flex flex-wrap items-center gap-3">
                <Button disabled={busy || testingConnection} onclick={testConnection}>
                    {testingConnection ? language.s3Testing : language.s3TestConnection}
                </Button>

                <Button className="bg-selected hover:opacity-90" disabled={busy} onclick={applyConfiguration}>
                    {busy ? language.s3Applying : language.s3Apply}
                </Button>
            </div>
        {/if}

        <!-- Storage Statistics & Migration Tools -->
        <div class="mt-6 border-t border-darkborderc pt-4">
            <h4 class="text-sm font-semibold">{language.s3StatsAndTools}</h4>
            <p class="mt-1 text-xs text-textcolor2">{language.s3StatsAndToolsDescription}</p>

            {#if stats}
                <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-3">
                        <div class="text-xs text-textcolor2">{language.s3StatsStorageType}</div>
                        <div class="mt-1 font-semibold text-textcolor">{stats.storageType === 's3' ? 'S3 / RustFS' : 'Local FS'}</div>
                    </div>
                    <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-3">
                        <div class="text-xs text-textcolor2">{language.s3StatsTotalObjects}</div>
                        <div class="mt-1 font-semibold text-textcolor">{stats.totalObjects.toLocaleString()}</div>
                    </div>
                    <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-3">
                        <div class="text-xs text-textcolor2">{language.s3StatsTotalSize}</div>
                        <div class="mt-1 font-semibold text-textcolor">{formatBytes(stats.totalSizeBytes)}</div>
                    </div>
                </div>
            {/if}

            <div class="mt-4 flex flex-wrap items-center gap-3">
                <Button disabled={migrating || !config.enabled} onclick={migrateToS3}>
                    {migrating ? language.s3Migrating : language.s3MigrateFromLocal}
                </Button>

                <Button disabled={rollingBack || !config.enabled} onclick={rollbackToLocal}>
                    {rollingBack ? language.s3RollingBack : language.s3RollbackToLocal}
                </Button>

                <Button disabled={generatingThumbnails || !config.enabled} onclick={generateThumbnails}>
                    {generatingThumbnails ? language.s3GeneratingThumbnails : language.s3GenerateThumbnails}
                </Button>
            </div>
        </div>
    {/if}
</section>

{#if activeTask && progressData}
    <div class="fixed bottom-6 right-6 z-50 w-96 max-w-[calc(100vw-3rem)] rounded-xl border border-darkborderc bg-darkbg/95 p-4 text-textcolor shadow-2xl backdrop-blur-md transition-all duration-300">
        <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
                <svg class="h-4 w-4 animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <h5 class="text-sm font-semibold">
                    {activeTask === 'migrate' ? language.s3MigratingTitle : (activeTask === 'thumbnails' ? language.s3GenerateThumbnailsTitle : language.s3RollingBackTitle)}
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
            {:else if activeTask === 'thumbnails'}
                <div>
                    생성: <span class="font-medium text-textcolor">{progressData.created ?? 0}</span> · 건너뜀: <span class="font-medium text-textcolor">{progressData.skipped ?? 0}</span>
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
